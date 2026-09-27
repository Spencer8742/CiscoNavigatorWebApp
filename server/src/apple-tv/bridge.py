#!/usr/bin/env python3
"""Persistent pyatv bridge. NDJSON on stdin/stdout; diagnostics stay on stderr."""

import asyncio
import base64
import json
import logging
import os
import socket
import sys
import time
from copy import deepcopy
from dataclasses import dataclass, field
from hashlib import sha256
from ipaddress import IPv4Address
from pathlib import Path
from typing import Any, Awaitable, Callable

import aiohttp
import pyatv
from pyatv import exceptions
from pyatv.const import PairingRequirement, Protocol
from pyatv.storage.file_storage import FileStorage

try:
    from pyatv.settings import MrpTunnel
except ImportError:  # a pyatv without the setting: the fallback simply does not apply
    MrpTunnel = None  # type: ignore[assignment]

try:
    from pyatv.support import net as pyatv_net
except ImportError:
    pyatv_net = None  # type: ignore[assignment]

# Every pyatv call gets a deadline. Without one a single command the device
# decides not to answer never returns, and because requests used to be handled
# one at a time that hung the whole bridge: every later button press timed out
# in Node with "Apple TV did not respond". tvOS 26 and 27 do exactly this —
# they complete the Companion handshake and then silently drop some commands.
COMMAND_TIMEOUT = 4.0
# Power and app launches are slow by nature: waking a sleeping Apple TV and
# listing installed apps both take seconds on healthy hardware.
POWER_TIMEOUT = 10.0
APP_TIMEOUT = 10.0
# Connecting is slow on hardware that leaves Companion commands unanswered.
# pyatv gives each Companion command five seconds, and a connect sends nine of
# them (_systemInfo, _touchStart, _sessionStart, TVRCSessionStart, _tiStart,
# the _iMC subscribe, then FetchAttentionState and two status subscribes), so a
# set that answers none of the later ones still needs well over the eight
# seconds this used to allow. The poller is the patient one; a button press
# uses the short budget and fails fast rather than hanging on a reconnect.
def seconds(name: str, default: float) -> float:
    """An override for a deadline, for hardware that needs a different one."""
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


# APPLE_TV_CONNECT_TIMEOUT raises this for a set that answers even more slowly
# than the default allows, without rebuilding the image.
CONNECT_TIMEOUT = seconds("APPLE_TV_CONNECT_TIMEOUT", 30.0)
RECONNECT_TIMEOUT = min(seconds("APPLE_TV_RECONNECT_TIMEOUT", 10.0), CONNECT_TIMEOUT)

# "auto" (pyatv decides), "disable" or "force". The MRP tunnel rides on AirPlay
# and carries now playing; when it will not start, pyatv fails the whole
# connect, Companion included, and the remote goes with it.
MRP_TUNNEL = os.environ.get("APPLE_TV_MRP_TUNNEL", "auto").strip().lower()

# Companion drives the buttons on a healthy Apple TV, but it is not the only
# thing that can: MRP carries every direction, playback and volume command too,
# and power with it. Only the screensaver, app shortcuts and swipe are
# Companion's alone. So when Companion will not connect, the remote does not
# have to go with it — pyatv fails the whole connect over one bad protocol, and
# dropping that protocol is what keeps the rest.
# "auto" lets the bridge drop it, "disable" never uses it, "force" keeps it
# even when it is what is stopping the connection.
COMPANION = os.environ.get("APPLE_TV_COMPANION", "auto").strip().lower()

# What Companion alone can do, so a button it owns fails saying that rather
# than looking like a dead remote.
COMPANION_ONLY = {"screensaver"}

# Who the bridge says it is when it introduces itself over Companion. pyatv's
# defaults claim an iPhone X on iOS 14.7.1 and a device id of FF:70:79:61:74:76
# — an address whose first octet has the multicast bit set, so not a valid
# unicast MAC at all. Both are candidates for a newer tvOS declining to answer
# _systemInfo, which is the first command a Companion connect sends. Override
# whichever turns out to matter; --identities finds out which on real hardware.
CLIENT_FIELDS = ("name", "model", "device_id", "mac", "os_name", "os_build", "os_version")
CLIENT_IDENTITY = {
    field: os.environ[key]
    for field in CLIENT_FIELDS
    if (key := f"APPLE_TV_CLIENT_{field.upper()}") in os.environ
    and os.environ[key].strip()
}


def local_mac(seed: str, first_octet: int = 0x02) -> str:
    """A stable, locally administered unicast MAC for this installation.

    Derived from the seed rather than random so it survives a restart: an
    Apple TV that has paired with one identity should keep recognising it.
    """
    digest = sha256(seed.encode("utf-8")).digest()
    octets = [first_octet] + list(digest[:5])
    return ":".join(f"{octet:02x}" for octet in octets)
METADATA_TIMEOUT = 5.0
ARTWORK_TIMEOUT = 10.0
SCAN_TIMEOUT = 5

# str() on these is '' — the panel used to show a bare "Apple TV command
# failed" because the bridge passed that empty string up as the reason.
CREDENTIAL_ERRORS: tuple[type[BaseException], ...] = (
    exceptions.AuthenticationError,
    exceptions.InvalidCredentialsError,
    exceptions.NoCredentialsError,
)
DROPPED_ERRORS: tuple[type[BaseException], ...] = (
    exceptions.ConnectionLostError,
    exceptions.ConnectionFailedError,
    exceptions.ProtocolError,
    ConnectionError,
    asyncio.TimeoutError,
    OSError,
)


def emit(value: dict[str, Any]) -> None:
    # One write, not print()'s two: several requests are in flight at once now
    # and a half-written line would be unparseable on the Node side.
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def trace(message: str) -> None:
    """Node pipes stderr into the server log, which is where a person looks."""
    print(message, file=sys.stderr, flush=True)


def text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def cause_of(exc: BaseException) -> str | None:
    """The underlying reason, when an exception was raised `from` another.

    pyatv wraps a lot of failures behind one sentence — "Failed to set up
    remote control channel" reads the same whether the device refused the
    credentials, hung up, or answered something unexpected — and keeps the
    real one as __cause__. Dropping it leaves nothing to act on.
    """
    seen: set[int] = set()
    # asyncio.wait_for raises TimeoutError *from* the CancelledError it used to
    # stop the inner task, so descending blindly turns "it timed out" into
    # "something cancelled it" — which reads like a bug on our side and sent
    # this hunt off in the wrong direction once already. Keep the first link
    # that names something, and never let cancellation be the answer.
    first: BaseException | None = None
    current = exc.__cause__
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if not isinstance(current, asyncio.CancelledError):
            if first is None:
                first = current
            message = str(current).strip()
            if message:
                return f"{type(current).__name__}: {message}"
        current = current.__cause__
    return type(first).__name__ if first is not None else None


def with_cause(text: str, exc: BaseException) -> str:
    cause = cause_of(exc)
    return f"{text} ({cause})" if cause else text


def describe(exc: BaseException, device: "Device | None" = None) -> str:
    """Turn an exception into something worth showing a person.

    pyatv raises most of its errors with no message at all, so str(exc) is ''
    for a rejected pairing, a dropped connection and a timeout alike. Anything
    that reaches the panel has to say more than nothing.
    """
    name = device.name if device is not None else "The Apple TV"
    if isinstance(exc, CREDENTIAL_ERRORS):
        return f"{name} rejected the saved pairing. Pair it again in Settings."
    if isinstance(exc, asyncio.TimeoutError):
        return f"{name} did not answer in time."
    if isinstance(exc, (exceptions.ConnectionLostError, ConnectionError)):
        return f"The connection to {name} dropped."
    if isinstance(exc, exceptions.ConnectionFailedError):
        return f"Could not open a connection to {name}."
    if isinstance(exc, exceptions.NotSupportedError):
        return f"{name} does not support that."
    message = str(exc).strip()
    if message:
        # pyatv's own wording ("Command FetchAttentionState failed") is the
        # most useful thing to show, but it never says which set it came from.
        return with_cause(
            message if device is None or name in message else f"{name}: {message}", exc
        )
    # Last resort: the class name still beats an empty string.
    return with_cause(f"{name} failed with {type(exc).__name__}.", exc)


def is_credential_problem(exc: BaseException) -> bool:
    return isinstance(exc, CREDENTIAL_ERRORS)


def off_subnet(host: str) -> str | None:
    """Say so when nothing here sits on the Apple TV's network.

    AirPlay's remote control channel is not a plain outbound connection. The
    RTSP session names this end by its own address — pyatv sends
    "SETUP rtsp://<our address>/<session>" — and the Apple TV has to be able to
    reach it. From a container on Docker's default bridge that address is
    something like 172.17.0.8, which nothing on the LAN can route to, so the
    Apple TV never answers and the channel times out. No amount of patience
    fixes it; the container has to be on the same network as the TV.
    """
    if pyatv_net is None:
        return None
    try:
        address = IPv4Address(socket.gethostbyname(host))
        if pyatv_net.get_local_address_reaching(address) is not None:
            return None
    except Exception:
        return None
    return (
        f"No network interface here is on the same subnet as {host}, so the Apple TV "
        "cannot open a connection back — which is what AirPlay's remote control "
        "channel needs. A container on Docker's default bridge network always looks "
        "like this. Run it with network_mode: host."
    )


def is_tunnel_failure(exc: BaseException) -> bool:
    """Whether AirPlay's remote control channel is what would not start.

    pyatv raises exactly this sentence from _create_mrp_tunnel_data when the
    MRP-over-AirPlay tunnel fails to set up. It is worth singling out because
    the tunnel is optional: without it there is no now playing, but Companion
    still drives every button, which is a great deal better than nothing.
    """
    return "remote control channel" in str(exc).lower()


def is_dropped_connection(exc: BaseException) -> bool:
    """Whether the handle we hold is worth keeping.

    A rejected pairing is included: the session is finished either way, and a
    reconnect is what surfaces the real state of the credentials.
    """
    return isinstance(exc, CREDENTIAL_ERRORS + DROPPED_ERRORS)


@dataclass
class Device:
    id: str
    name: str
    host: str
    identifier: str | None = None
    atv: Any = None
    pairing: Any = None
    pairing_state: str = "idle"
    pairing_protocol: Any = None
    pairing_target: str | None = None
    paired: bool = False
    remote_paired: bool = False
    media_paired: bool = False
    artwork_id: str | None = None
    error: str | None = None
    # The last config a scan returned. Reconnecting from it skips a five second
    # rescan, which is what keeps a self-healing retry quick enough to be worth
    # doing on the command path. Cleared whenever credentials may have changed.
    config: Any = None
    # Set once AirPlay's remote control channel has refused to start, so the
    # next connect skips it instead of failing over it again.
    tunnel_disabled: bool = False
    # Set once Companion has refused to connect. MRP then drives the buttons.
    companion_disabled: bool = False
    # The aiohttp session behind this connection. We create it instead of
    # letting pyatv create its own — see _open().
    session: Any = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class Listener:
    def __init__(self, bridge: "Bridge", device: Device):
        self.bridge = bridge
        self.device = device

    def connection_lost(self, exception: Exception) -> None:
        self.device.atv = None
        self.device.error = describe(exception, self.device)
        trace(f"[{self.device.id}] connection lost: {self.device.error}")
        asyncio.create_task(self.bridge.publish(self.device))

    def connection_closed(self) -> None:
        self.device.atv = None
        asyncio.create_task(self.bridge.publish(self.device))

    def playstatus_update(self, updater: Any, playstatus: Any) -> None:
        asyncio.create_task(self.bridge.publish(self.device, playstatus))

    def playstatus_error(self, updater: Any, exception: Exception) -> None:
        self.device.error = describe(exception, self.device)
        asyncio.create_task(self.bridge.publish(self.device))

    def powerstate_update(self, old_state: Any, new_state: Any) -> None:
        asyncio.create_task(self.bridge.publish(self.device))


class Bridge:
    def __init__(self, storage_file: str):
        self.loop = asyncio.get_running_loop()
        self.storage = FileStorage(storage_file, self.loop)
        self.storage_file = storage_file
        self.devices: dict[str, Device] = {}
        self.poller: asyncio.Task[Any] | None = None
        self.background: set[asyncio.Task[Any]] = set()

    def spawn(self, work: Any) -> None:
        """Run something without making the caller wait for it."""
        task = asyncio.ensure_future(work)
        self.background.add(task)
        task.add_done_callback(self.background.discard)

    async def start(self) -> None:
        Path(self.storage_file).parent.mkdir(parents=True, exist_ok=True)
        await self.storage.load()
        self.poller = asyncio.create_task(self.poll())

    async def configure(self, specs: list[dict[str, Any]]) -> None:
        wanted = {str(s["id"]): s for s in specs if s.get("id") and s.get("host")}
        for device_id in list(self.devices):
            if device_id not in wanted:
                await self.close_device(self.devices.pop(device_id))
        for device_id, spec in wanted.items():
            current = self.devices.get(device_id)
            host = str(spec["host"])
            identifier = text(spec.get("identifier"))
            if current and current.host == host and current.identifier == identifier:
                current.name = str(spec.get("name") or device_id)
                continue
            if current:
                await self.close_device(current)
            self.devices[device_id] = Device(device_id, str(spec.get("name") or device_id), host, identifier)
        # Connect in the background. A set that takes half a minute to answer
        # must not hold up the panel's configure round trip, and each device
        # reports itself with a state message as soon as it is up.
        for device in self.devices.values():
            await self.publish(device)
            self.spawn(self.connect(device))

    async def scan(self, device: Device) -> Any:
        found = await pyatv.scan(
            self.loop,
            timeout=SCAN_TIMEOUT,
            hosts=[device.host],
            identifier=device.identifier,
            storage=self.storage,
        )
        if not found:
            raise RuntimeError(f"No Apple TV answered at {device.host}")
        return found[0]

    async def connect(
        self, device: Device, timeout: float = CONNECT_TIMEOUT, degrade: bool = True
    ) -> None:
        """Open a connection, giving the device `timeout` seconds to answer.

        The poller connects patiently and is the one allowed to work down the
        ladder of protocols; a button press passes the short budget and no
        degrading, so it never sits through three rounds. If a connect is
        already running, a second caller leaves it alone rather than queueing
        behind it — a press should say so immediately instead of waiting out
        somebody else's deadline.
        """
        if device.lock.locked():
            return
        # One connect at a time per device: a command that hit a dead session
        # and the poller can both want one at the same moment.
        async with device.lock:
            if device.atv is not None or device.pairing is not None:
                return
            # pyatv fails a connect if any one protocol fails, so a single sick
            # protocol takes the working ones with it. Each round drops the one
            # that just failed and tries again with what is left.
            for attempt in (1, 2, 3):
                try:
                    await asyncio.wait_for(self._open(device), timeout)
                    break
                except Exception as exc:  # network and protocol errors are state, not crashes
                    # The deadline can land after pyatv.connect() returned but
                    # before the listeners were attached, so there may be a real
                    # connection here to let go of rather than leak.
                    orphan, device.atv = device.atv, None
                    if orphan is not None:
                        try:
                            orphan.close()
                        except Exception:
                            pass
                    await self.close_session(device)
                    # The scan result stays until we give up: the next rung of
                    # the ladder only turns a protocol off, so rescanning would
                    # cost five seconds to learn nothing — and can_drop_companion
                    # needs the services it lists to decide at all.
                    if (
                        degrade
                        and MRP_TUNNEL == "auto"
                        and not device.tunnel_disabled
                        and is_tunnel_failure(exc)
                    ):
                        device.tunnel_disabled = True
                        trace(f"[{device.id}] {describe(exc, device)}; retrying without it")
                        continue
                    if (
                        degrade
                        and COMPANION == "auto"
                        and not device.companion_disabled
                        and self.can_drop_companion(device)
                    ):
                        # Whatever went wrong, Companion is the protocol most
                        # likely to be behind it and the one the remote can do
                        # without. MRP still carries the buttons.
                        device.companion_disabled = True
                        trace(f"[{device.id}] {describe(exc, device)}; retrying without Companion")
                        continue
                    device.config = None
                    if is_credential_problem(exc):
                        self.credentials_rejected(device, None)
                    device.error = describe(exc, device)
                    routing = off_subnet(device.host)
                    if routing and is_tunnel_failure(exc):
                        device.error = f"{device.error} {routing}"
                    trace(f"[{device.id}] connect failed: {device.error}")
                    break
        await self.publish(device)

    async def _open(self, device: Device) -> None:
        config = device.config
        if config is None:
            config = await self.scan(device)
        device.config = config
        await self.apply_tunnel_setting(config, device)
        device.remote_paired, device.media_paired = self.pairing_status(config)
        device.paired = device.remote_paired and device.media_paired
        if device.pairing_state not in ("starting", "pin"):
            device.pairing_target = None if device.paired else ("remote" if not device.remote_paired else "media")
        # pyatv would make its own aiohttp session, and clean it up in a
        # handler guarded by `except Exception`. Our deadline cancels the
        # connect instead, and CancelledError is not an Exception, so that
        # cleanup never runs and the session is orphaned ("Unclosed client
        # session", once per attempt, forever on a set that never answers).
        # Owning it is what makes it ours to close.
        device.session = aiohttp.ClientSession()
        atv = await pyatv.connect(
            config, self.loop, storage=self.storage, session=device.session
        )
        device.atv = atv
        device.config = config
        device.error = None
        listener = Listener(self, device)
        atv.listener = listener
        atv.push_updater.listener = listener
        try:
            atv.power.listener = listener
        except Exception:
            pass
        atv.push_updater.start()
        # Not errors exactly, but the panel should not silently show a dead
        # shortcut or an empty now-playing card as though nothing were playing.
        if device.companion_disabled:
            device.error = (
                f"{device.name} would not answer Companion, so the buttons are going "
                "over AirPlay instead. App shortcuts, swipe and the screensaver button "
                "are unavailable until it answers again."
            )
        elif device.tunnel_disabled:
            routing = off_subnet(device.host)
            device.error = (
                f"{device.name} would not start its remote control channel. The buttons "
                "work; now playing is unavailable. "
            ) + (routing or "Pair media access again to restore it.")

    def can_drop_companion(self, device: Device) -> bool:
        """Whether anything would be left to drive the buttons without it."""
        config = device.config
        if config is None:
            return False
        if config.get_service(Protocol.Companion) is None:
            return False
        return any(
            config.get_service(protocol) is not None
            for protocol in (Protocol.MRP, Protocol.AirPlay)
        )

    async def apply_tunnel_setting(self, config: Any, device: Device) -> None:
        """Choose whether pyatv sets up the MRP-over-AirPlay tunnel, and who we are.

        get_settings() hands back the live object out of storage, so setting
        these is what pyatv reads on the next connect. They are deliberately not
        saved: a device that starts answering again should get its now playing
        back without anyone having to undo anything.
        """
        if CLIENT_IDENTITY:
            try:
                info = (await self.storage.get_settings(config)).info
                for field, value in CLIENT_IDENTITY.items():
                    setattr(info, field, value)
            except Exception as exc:
                trace(f"[{device.id}] could not set the client identity: {describe(exc, device)}")
        companion = config.get_service(Protocol.Companion)
        if companion is not None:
            # pyatv skips a service whose `enabled` is False, which is how a
            # protocol gets left out of a connect.
            companion.enabled = not (device.companion_disabled or COMPANION == "disable")
        if MrpTunnel is None:
            return
        # Only "auto" leaves the choice to us; asking for the tunnel outright,
        # or for none, is an instruction and the fallback does not override it.
        mode = "disable" if device.tunnel_disabled else MRP_TUNNEL
        if mode not in ("auto", "disable", "force"):
            mode = "auto"
        try:
            settings = await self.storage.get_settings(config)
            settings.protocols.airplay.mrp_tunnel = MrpTunnel(mode)
        except Exception as exc:
            trace(f"[{device.id}] could not set the MRP tunnel mode: {describe(exc, device)}")

    async def close_session(self, device: Device) -> None:
        session, device.session = device.session, None
        if session is not None:
            try:
                await session.close()
            except Exception:
                pass

    async def drop(self, device: Device, atv: Any, exc: BaseException) -> None:
        """Let go of a handle that cannot do anything any more.

        pyatv only calls connection_lost when it notices the socket go away. A
        session the device has stopped answering looks alive from here, so
        without this the bridge holds a dead handle forever: connect() returns
        early because atv is not None, the poller leaves it alone, and every
        press fails until the container is restarted.

        Only the handle the caller actually used is dropped: two presses can
        fail on the same dead session at once, and the second must not throw
        away the connection the first has just rebuilt.
        """
        if atv is None or device.atv is not atv:
            return
        device.atv = None
        if is_credential_problem(exc):
            # Re-scan next time: the credentials on the device have changed.
            device.config = None
        try:
            atv.close()
        except Exception:
            pass
        await self.close_session(device)

    def credentials_rejected(self, device: Device, target: str | None) -> None:
        """Mark a protocol as needing to be paired again.

        A tvOS update can invalidate the stored credentials while leaving them
        on disk, so pairing_status() still reports the device as paired and the
        panel offers no way out. Only an actual rejection tells the truth.
        """
        if target == "remote":
            device.remote_paired = False
        elif target == "media":
            device.media_paired = False
        else:
            device.remote_paired = False
            device.media_paired = False
        device.paired = device.remote_paired and device.media_paired
        device.config = None
        if device.pairing_state not in ("starting", "pin"):
            device.pairing_target = "remote" if not device.remote_paired else "media"

    def unavailable(self, device: Device) -> str:
        """Why a command could not be sent, for someone holding the panel."""
        if device.lock.locked():
            # The poller is mid-connect on its longer budget. Saying so beats
            # making the press wait out a deadline it did not set.
            return f"{device.name} is still connecting. Try again in a moment."
        return device.error or f"{device.name} is not connected."

    async def perform(
        self,
        device: Device,
        target: str,
        action: Callable[[Any], Awaitable[Any]],
        timeout: float = COMMAND_TIMEOUT,
    ) -> Any:
        """Run one pyatv call, and get the connection back if it has gone.

        Every call is bounded, and a failure that means "this session is over"
        buys exactly one reconnect and one retry — enough to ride out the
        session a sleeping or freshly updated Apple TV drops, without turning a
        genuinely broken device into a long wait.
        """
        if device.atv is None:
            await self.connect(device, RECONNECT_TIMEOUT, degrade=False)
        atv = device.atv
        if atv is None:
            raise RuntimeError(self.unavailable(device))
        try:
            return await asyncio.wait_for(action(atv), timeout)
        except Exception as exc:
            if not is_dropped_connection(exc):
                raise
            trace(f"[{device.id}] retrying after: {describe(exc, device)}")
            credentials = is_credential_problem(exc)
            await self.drop(device, atv, exc)
            await self.connect(device, RECONNECT_TIMEOUT, degrade=False)
            retry = device.atv
            if retry is None:
                if credentials:
                    self.credentials_rejected(device, target)
                    await self.publish(device)
                raise RuntimeError(device.error or describe(exc, device))
            try:
                return await asyncio.wait_for(action(retry), timeout)
            except Exception as retry_exc:
                if is_dropped_connection(retry_exc):
                    # Do not keep a handle that has now failed twice: letting
                    # the poller rebuild it in the background means the next
                    # press is not charged for discovering that again.
                    if is_credential_problem(retry_exc):
                        self.credentials_rejected(device, target)
                    await self.drop(device, retry, retry_exc)
                    await self.publish(device)
                raise

    async def close_device(self, device: Device) -> None:
        if device.pairing is not None:
            await device.pairing.close()
            device.pairing = None
        if device.atv is not None:
            device.atv.close()
            device.atv = None
        await self.close_session(device)

    async def publish(self, device: Device, playing: Any = None) -> None:
        atv = device.atv
        if atv is not None and playing is None:
            try:
                playing = await asyncio.wait_for(atv.metadata.playing(), METADATA_TIMEOUT)
            except Exception:
                playing = None
        power = "unknown"
        app = None
        if atv is not None:
            try:
                power = str(atv.power.power_state.name).lower()
            except Exception:
                power = "unknown"
            try:
                current_app = atv.metadata.app
                app = current_app.name if current_app else None
            except Exception:
                app = None
        artwork_id = None
        if atv is not None and playing is not None:
            try:
                artwork_id = atv.metadata.artwork_id or playing.hash
            except Exception:
                artwork_id = playing.hash
        if artwork_id != device.artwork_id:
            device.artwork_id = artwork_id
            artwork = None
            if artwork_id and atv is not None:
                try:
                    artwork = await asyncio.wait_for(
                        atv.metadata.artwork(width=640, height=None), ARTWORK_TIMEOUT
                    )
                except Exception:
                    artwork = None
            emit({
                "t": "artwork",
                "device": device.id,
                "version": artwork_id,
                "mimetype": artwork.mimetype if artwork else None,
                "data": base64.b64encode(artwork.bytes).decode("ascii") if artwork else None,
            })
        state = {
            "id": device.id,
            "name": device.name,
            "reachable": atv is not None,
            "paired": device.paired,
            "pairing": device.pairing_state,
            "pairingTarget": device.pairing_target,
            "power": power if power in ("on", "off") else "unknown",
            "playback": str(playing.device_state.name).lower() if playing else "idle",
            "mediaType": str(playing.media_type.name).lower() if playing else "unknown",
            "title": text(playing.title) if playing else None,
            "artist": text(playing.artist) if playing else None,
            "album": text(playing.album) if playing else None,
            "app": app,
            "artwork": None,
            "elapsed": playing.position if playing else None,
            "duration": playing.total_time if playing else None,
            "elapsedAt": int(time.time() * 1000),
            "error": text(device.error),
        }
        # Node converts this monotonic stamp to wall time before publishing.
        emit({"t": "state", "state": state})

    async def command(self, device: Device, op: str) -> None:
        if op == "power_on":
            await self.perform(device, "remote", lambda atv: atv.power.turn_on(), POWER_TIMEOUT)
        elif op == "power_off":
            await self.perform(device, "remote", lambda atv: atv.power.turn_off(), POWER_TIMEOUT)
        else:
            allowed = {
                "up", "down", "left", "right", "select", "menu", "home",
                "play_pause", "play", "pause", "stop", "next", "previous",
                "skip_forward", "skip_backward", "volume_up", "volume_down", "screensaver",
            }
            if op not in allowed:
                raise RuntimeError("Unsupported Apple TV command")
            if op in COMPANION_ONLY and device.companion_disabled:
                raise RuntimeError(
                    f"{device.name} is not answering Companion, which is the only thing "
                    f"that can do that. The other buttons still work."
                )
            await self.perform(device, "remote", lambda atv: getattr(atv.remote_control, op)())
        await self.publish(device)

    async def swipe(self, device: Device, message: dict[str, Any]) -> None:
        values = [message.get(key) for key in ("startX", "startY", "endX", "endY")]
        duration = message.get("durationMs")
        if not all(isinstance(value, int) and 0 <= value <= 1000 for value in values):
            raise RuntimeError("Swipe coordinates are invalid")
        if not isinstance(duration, int) or not 100 <= duration <= 2000:
            raise RuntimeError("Swipe duration is invalid")
        if device.companion_disabled:
            raise RuntimeError(
                f"{device.name} is not answering Companion, so swipe is unavailable. "
                "Use the direction buttons."
            )
        # A swipe is allowed to outlast its own duration on the wire.
        await self.perform(
            device,
            "remote",
            lambda atv: atv.touch.swipe(*values, duration),
            timeout=COMMAND_TIMEOUT + duration / 1000,
        )

    async def launch_app(self, device: Device, bundle_id: str, name: str) -> None:
        if device.companion_disabled:
            raise RuntimeError(
                f"{device.name} is not answering Companion, so apps cannot be launched. "
                "The remote buttons still work."
            )

        async def run(atv: Any) -> None:
            apps = await atv.apps.app_list()
            if not any(app.identifier == bundle_id for app in apps):
                # Not a connection problem, so perform() will not retry it.
                raise RuntimeError(f"{name or bundle_id} is not installed on this Apple TV")
            await atv.apps.launch_app(bundle_id)

        await self.perform(device, "remote", run, APP_TIMEOUT)
        await self.publish(device)

    async def pair_begin(self, device: Device) -> None:
        await self.close_device(device)
        device.pairing_state = "starting"
        device.error = None
        device.config = None
        await self.publish(device)
        config = await self.scan(device)
        remote_ready, media_ready = self.pairing_status(config)
        protocol = None
        target = None
        if not remote_ready and self.can_pair(config, Protocol.Companion):
            protocol, target = Protocol.Companion, "remote"
        elif not media_ready and self.can_pair(config, Protocol.AirPlay):
            protocol, target = Protocol.AirPlay, "media"
        elif not media_ready and self.can_pair(config, Protocol.MRP):
            protocol, target = Protocol.MRP, "media"
        if protocol is None:
            raise RuntimeError("No additional Apple TV pairing protocol is available")
        device.pairing_protocol = protocol
        device.pairing_target = target
        device.pairing = await pyatv.pair(
            config, protocol, self.loop, storage=self.storage, name="Navigator Remote"
        )
        await device.pairing.begin()
        device.pairing_state = "pin"
        await self.publish(device)

    async def pair_pin(self, device: Device, pin: str) -> None:
        if device.pairing is None:
            raise RuntimeError("Start pairing first")
        if not pin.isdigit() or not 4 <= len(pin) <= 6:
            raise RuntimeError("Enter the PIN shown on the Apple TV")
        device.pairing.pin(pin)
        await device.pairing.finish()
        if not device.pairing.has_paired:
            raise RuntimeError("Apple TV rejected the PIN")
        device.paired = True
        if device.pairing_target == "remote":
            device.remote_paired = True
        else:
            device.media_paired = True
        device.paired = device.remote_paired and device.media_paired
        device.pairing_state = "paired"
        await device.pairing.close()
        device.pairing = None
        device.pairing_protocol = None
        device.pairing_target = None
        await self.storage.save()
        # The cached config still carries the credentials from before pairing.
        device.config = None
        await self.publish(device)
        # Pairing is done once the credentials are stored; connecting with them
        # can take its own time without holding up the PIN's answer.
        self.spawn(self.connect(device))

    async def pair_cancel(self, device: Device) -> None:
        if device.pairing is not None:
            await device.pairing.close()
            device.pairing = None
        device.pairing_state = "idle"
        device.pairing_protocol = None
        device.pairing_target = None
        await self.publish(device)

    @staticmethod
    def can_pair(config: Any, protocol: Protocol) -> bool:
        service = config.get_service(protocol)
        return bool(service and not service.credentials and service.pairing in (
            PairingRequirement.Mandatory, PairingRequirement.Optional
        ))

    @staticmethod
    def pairing_status(config: Any) -> tuple[bool, bool]:
        companion = config.get_service(Protocol.Companion)
        remote = bool(companion and (
            companion.credentials or companion.pairing == PairingRequirement.NotNeeded
        ))
        mrp = config.get_service(Protocol.MRP)
        airplay = config.get_service(Protocol.AirPlay)
        media = bool(
            (mrp and (mrp.credentials or mrp.pairing == PairingRequirement.NotNeeded))
            or (airplay and airplay.credentials)
        )
        return remote, media

    async def request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        try:
            kind = message.get("t")
            if kind == "configure":
                await self.configure(message.get("devices") or [])
            else:
                device = self.devices.get(str(message.get("device")))
                if device is None:
                    raise RuntimeError("Apple TV is not configured")
                if kind == "command":
                    await self.command(device, str(message.get("op")))
                elif kind == "swipe":
                    await self.swipe(device, message)
                elif kind == "launch-app":
                    await self.launch_app(
                        device,
                        str(message.get("app") or ""),
                        str(message.get("name") or message.get("app") or "App"),
                    )
                elif kind == "pair-begin":
                    await self.pair_begin(device)
                elif kind == "pair-pin":
                    await self.pair_pin(device, str(message.get("pin") or ""))
                elif kind == "pair-cancel":
                    await self.pair_cancel(device)
                else:
                    raise RuntimeError("Unknown bridge request")
            emit({"t": "response", "id": request_id, "ok": True})
        except Exception as exc:
            device = self.devices.get(str(message.get("device")))
            reason = describe(exc, device)
            trace(f"[{message.get('device')}] {message.get('t')} failed: {reason}")
            if device is not None:
                device.error = reason
                device.pairing_state = "error" if str(message.get("t", "")).startswith("pair") else device.pairing_state
                await self.publish(device)
            emit({"t": "response", "id": request_id, "ok": False, "error": reason})

    async def poll(self) -> None:
        while True:
            await asyncio.sleep(3)
            # Concurrently, and never waiting on a device that has gone quiet:
            # a single unreachable Apple TV used to hold up the whole round.
            await asyncio.gather(
                *(self.refresh(device) for device in list(self.devices.values())),
                return_exceptions=True,
            )

    async def refresh(self, device: Device) -> None:
        try:
            if device.atv is None and device.pairing is None:
                await self.connect(device)
            elif device.atv is not None:
                await self.publish(device)
        except Exception as exc:
            trace(f"[{device.id}] refresh failed: {describe(exc, device)}")


# A probe is allowed to be far more patient than the running bridge: the whole
# point is to find out whether a set ever answers, and how long it takes.
PROBE_CONNECT_TIMEOUT = 45.0


async def attempt(
    loop: Any, storage: Any, config: Any, budget: float, only: Any = None
) -> tuple[Any, Any, float, BaseException | None]:
    """Connect once, optionally with only some protocols enabled.

    Returns the connection, its session, how long it took, and what went wrong.
    Disabling the others is how we find out which protocol is the one hanging:
    pyatv.connect() skips a service whose `enabled` is False.
    """
    candidate = deepcopy(config)
    if only is not None:
        for proto in Protocol:
            service = candidate.get_service(proto)
            if service is not None and proto not in only:
                service.enabled = False
    session = aiohttp.ClientSession()
    started = time.monotonic()
    try:
        atv = await asyncio.wait_for(
            pyatv.connect(candidate, loop, storage=storage, session=session), budget
        )
        return atv, session, time.monotonic() - started, None
    except BaseException as exc:  # noqa: BLE001 - a probe reports, it does not raise
        await session.close()
        return None, None, time.monotonic() - started, exc


async def probe(host: str, storage_file: str, identifier: str | None, debug: bool) -> int:
    """Report what an Apple TV actually offers, and what it refuses.

    Nothing here changes what is on screen and nothing appears on the TV: it
    scans, connects, and exercises the read paths that use the same sessions
    the remote does. Companion is what a tvOS update tends to break, and
    app_list() rides on it, so a Companion session that has stopped answering
    shows up here as a named failure rather than as a dead button in the panel.

        python3 apple-tv-bridge.py --probe 192.168.1.50 /config/apple-tv.json
        python3 apple-tv-bridge.py --probe 192.168.1.50 /config/apple-tv.json --debug
    """
    if debug:
        logging.basicConfig(
            level=logging.DEBUG,
            stream=sys.stderr,
            format="%(relativeCreated)6.0fms %(levelname)-7s %(name)s: %(message)s",
        )

    loop = asyncio.get_running_loop()
    storage = FileStorage(storage_file, loop)
    Path(storage_file).parent.mkdir(parents=True, exist_ok=True)
    await storage.load()

    def line(status: str, message: str) -> None:
        # Flushed: run through `docker exec` this is a pipe, and a probe that
        # buffers its output for half a minute looks exactly like one that hung.
        print(f"{status:<6} {message}", flush=True)

    print(f"Probing {host} (credentials from {storage_file})", flush=True)
    print("Nothing will appear on the Apple TV - this only reads.\n", flush=True)

    try:
        found = await pyatv.scan(
            loop, timeout=SCAN_TIMEOUT, hosts=[host], identifier=identifier, storage=storage
        )
    except Exception as exc:
        line("FAIL", f"scan: {describe(exc)}")
        return 1
    if not found:
        line("FAIL", f"Nothing answered at {host}. Check the address and that the Apple TV is awake.")
        return 1

    config = found[0]
    info = getattr(config, "device_info", None)
    line("OK", f"Found {config.name} ({getattr(config, 'identifier', '?')})")
    if info is not None:
        version = getattr(info, "version", None)
        model = getattr(info, "raw_model", None) or getattr(info, "model", None)
        line("INFO", f"{model} running {getattr(info, 'operating_system', '?')} {version or '?'}")

    for protocol in (Protocol.Companion, Protocol.AirPlay, Protocol.MRP, Protocol.RAOP):
        service = config.get_service(protocol)
        if service is None:
            line("INFO", f"{protocol.name}: not advertised")
            continue
        held = "credentials stored" if service.credentials else "NO credentials"
        line("INFO", f"{protocol.name}: {held}, pairing {getattr(service.pairing, 'name', service.pairing)}")

    remote_ready, media_ready = Bridge.pairing_status(config)
    line("OK" if remote_ready else "FAIL", f"remote control (Companion) {'paired' if remote_ready else 'NOT paired'}")
    line("OK" if media_ready else "FAIL", f"media access (AirPlay/MRP) {'paired' if media_ready else 'NOT paired'}")

    routing = off_subnet(host)
    if routing:
        line("FAIL", "this machine is not on the Apple TV's network")
        for sentence in routing.split(". "):
            if sentence.strip():
                line("", f"  {sentence.strip().rstrip('.')}.")
    else:
        line("OK", "on the same network as the Apple TV")

    line("INFO", f"connecting, up to {PROBE_CONNECT_TIMEOUT:.0f}s...")
    atv, session, elapsed, error = await attempt(loop, storage, config, PROBE_CONNECT_TIMEOUT)
    if error is not None:
        line("FAIL", f"connect: {describe(error)} (gave up after {elapsed:.1f}s)")
        # Narrow it down. Each protocol is tried on its own, so the output says
        # which one is not answering rather than only that something is not.
        print("", flush=True)
        line("INFO", "trying each protocol on its own to find the one at fault:")
        culprits = []
        for name, only in (
            ("Companion (the remote)", {Protocol.Companion}),
            ("AirPlay (now playing)", {Protocol.AirPlay, Protocol.MRP}),
        ):
            if not any(config.get_service(p) for p in only):
                continue
            solo, solo_session, solo_elapsed, solo_error = await attempt(
                loop, storage, config, PROBE_CONNECT_TIMEOUT, only
            )
            if solo_error is None:
                line("OK", f"{name}: connected on its own in {solo_elapsed:.1f}s")
                solo.close()
                if solo_session is not None:
                    await solo_session.close()
            else:
                culprits.append(name)
                line("FAIL", f"{name}: {describe(solo_error)} after {solo_elapsed:.1f}s")
        print("", flush=True)
        if routing:
            # This outranks every other explanation: until it is fixed, nothing
            # below it can be trusted to mean what it usually means.
            print("Fix the networking first. " + routing, flush=True)
            print("", flush=True)
            print("In docker-compose.yml, replace the `ports:` block with:", flush=True)
            print("    network_mode: host", flush=True)
            print("then recreate the container. The panel is then on the host's", flush=True)
            print("own port 8099 rather than a published one.", flush=True)
        elif culprits == ["Companion (the remote)"]:
            # The one degraded state worth describing rather than diagnosing:
            # AirPlay answered, so the bridge has something to fall back to and
            # the remote is not lost. Telling someone to re-pair here would send
            # them undoing a pairing that works.
            print("Companion is not answering, but AirPlay is.", flush=True)
            print("The bridge connects without Companion, and the buttons go over", flush=True)
            print("AirPlay instead: directions, select, menu, home, playback, volume", flush=True)
            print("and power all work. App shortcuts, swipe and the screensaver button", flush=True)
            print("are Companion's alone and stay unavailable until it answers again.", flush=True)
            print("Nothing here needs re-pairing.", flush=True)
        elif culprits:
            print(f"Not answering: {', '.join(culprits)}.", flush=True)
            print("If the pairing lines above say paired, the Apple TV is holding", flush=True)
            print("credentials it no longer honours: remove this device under Settings >", flush=True)
            print("General > AirPlay and HomeKit > ... and pair again from the panel.", flush=True)
        else:
            print("Each protocol connects alone but not together, which points at the", flush=True)
            print("time the full connect takes rather than at any one of them. Raising", flush=True)
            print("APPLE_TV_CONNECT_TIMEOUT above the slowest figure above should do it.", flush=True)
        print("Re-run with --debug to see the individual commands and which one stalls.", flush=True)
        return 1

    line("OK", f"connected in {elapsed:.1f}s")
    if elapsed > CONNECT_TIMEOUT:
        line(
            "WARN",
            f"that is longer than the bridge allows ({CONNECT_TIMEOUT:.0f}s); "
            f"set APPLE_TV_CONNECT_TIMEOUT={int(elapsed) + 15} on the container.",
        )

    failures = 0
    try:
        # Companion. This is the one a tvOS update usually takes out.
        started = time.monotonic()
        try:
            apps = await asyncio.wait_for(atv.apps.app_list(), APP_TIMEOUT)
            line("OK", f"Companion answered in {time.monotonic() - started:.1f}s: {len(apps)} apps installed")
        except Exception as exc:
            failures += 1
            line("FAIL", f"Companion (app list): {describe(exc)}")

        # MRP or AirPlay, which is what drives the now-playing card.
        started = time.monotonic()
        try:
            playing = await asyncio.wait_for(atv.metadata.playing(), METADATA_TIMEOUT)
            line("OK", f"media session answered in {time.monotonic() - started:.1f}s: {playing.device_state.name}")
        except Exception as exc:
            failures += 1
            line("FAIL", f"media session (now playing): {describe(exc)}")

        try:
            line("OK", f"power state: {atv.power.power_state.name}")
        except Exception as exc:
            line("WARN", f"power state unavailable: {describe(exc)}")
    finally:
        atv.close()
        if session is not None:
            await session.close()

    print("", flush=True)
    if failures:
        print("Some sessions did not answer. If the pairing lines above say paired but a", flush=True)
        print("session still fails, the Apple TV is holding credentials it no longer honours:", flush=True)
        print("remove this device under Settings > General > AirPlay and HomeKit > ... and", flush=True)
        print("pair it again from the panel.", flush=True)
    else:
        print("Everything answered. The Apple TV is reachable and paired.", flush=True)
    return 1 if failures else 0


PAIRABLE = {
    "companion": (Protocol.Companion, "the remote buttons"),
    "airplay": (Protocol.AirPlay, "now playing and media access"),
    "raop": (Protocol.RAOP, "audio streaming"),
    "mrp": (Protocol.MRP, "now playing (older tvOS)"),
}


async def ask(prompt: str) -> str:
    """Read a line without blocking the loop. Needs `docker exec -it`."""
    return (await asyncio.to_thread(input, prompt)).strip()


async def pair_cli(
    host: str, storage_file: str, identifier: str | None, choice: str | None, debug: bool
) -> int:
    """Pair a protocol from a terminal, PIN and all.

    The panel can do this too, but only for a protocol it believes is unpaired
    — and credentials that the Apple TV has quietly stopped honouring still
    look paired from here, so the panel offers no way to replace them. This
    does: it clears the stored credentials for the protocol first, which is
    what makes the device show a PIN again.

        docker exec -it navigator-panel /opt/pyatv/bin/python \\
          /app/dist/apple-tv-bridge.py --pair 192.168.1.50 /config/apple-tv.json airplay
    """
    if debug:
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)

    loop = asyncio.get_running_loop()
    storage = FileStorage(storage_file, loop)
    Path(storage_file).parent.mkdir(parents=True, exist_ok=True)
    await storage.load()

    def say(message: str = "") -> None:
        print(message, flush=True)

    say(f"Pairing with {host} (credentials in {storage_file})\n")
    found = await pyatv.scan(
        loop, timeout=SCAN_TIMEOUT, hosts=[host], identifier=identifier, storage=storage
    )
    if not found:
        say(f"Nothing answered at {host}.")
        return 1
    config = found[0]
    say(f"Found {config.name} ({getattr(config, 'identifier', '?')})\n")

    available = [
        (key, protocol, purpose)
        for key, (protocol, purpose) in PAIRABLE.items()
        if config.get_service(protocol) is not None
    ]
    if choice is None:
        say("Which one?")
        for index, (key, protocol, purpose) in enumerate(available, 1):
            service = config.get_service(protocol)
            held = "credentials stored" if service.credentials else "not paired"
            say(f"  {index}. {key:<10} {purpose} ({held})")
        answer = await ask("\nNumber or name: ")
        if answer.isdigit() and 1 <= int(answer) <= len(available):
            choice = available[int(answer) - 1][0]
        else:
            choice = answer.lower()

    if choice not in PAIRABLE:
        say(f"'{choice}' is not one of: {', '.join(PAIRABLE)}")
        return 1
    protocol, purpose = PAIRABLE[choice]
    service = config.get_service(protocol)
    if service is None:
        say(f"This Apple TV does not advertise {protocol.name}.")
        return 1

    # The credentials have to go before the device will show a PIN again: with
    # them in place pyatv verifies instead of pairing, which is the state this
    # whole exercise is trying to get out of.
    if service.credentials:
        say(f"{protocol.name} already has stored credentials for {purpose}.")
        if (await ask("Replace them and pair again? [y/N] ")).lower() not in ("y", "yes"):
            return 1
        settings = await storage.get_settings(config)
        setattr(getattr(settings.protocols, choice), "credentials", None)
        service.credentials = None
        await storage.save()
        say("Cleared. The Apple TV will treat this as a new pairing.\n")

    pairing = await pyatv.pair(
        config, protocol, loop, storage=storage, name="Navigator Remote"
    )
    try:
        await pairing.begin()
        if pairing.device_provides_pin:
            say("A four digit code should now be on the TV.")
            say("If nothing appears, check you are looking at the right Apple TV,")
            say("and that it is awake and not on a screensaver.")
            pin = await ask("\nCode shown on the TV: ")
            pairing.pin(pin)
        else:
            say('This protocol wants a PIN from us: enter 1234 on the Apple TV.')
            pairing.pin(1234)
            await ask("Press Enter once the Apple TV has accepted it: ")
        await pairing.finish()
        if not pairing.has_paired:
            say("\nThe Apple TV did not accept that. Nothing was saved.")
            return 1
        await storage.save()
        say(f"\nPaired. {protocol.name} credentials for {purpose} are stored.")
        say("Run --probe to confirm, then restart the container so the bridge picks them up.")
        return 0
    except Exception as exc:
        say(f"\nPairing failed: {describe(exc)}")
        return 1
    finally:
        await pairing.close()


def candidate_identities(seed: str) -> list[tuple[str, dict[str, str]]]:
    """Client identities to try, cheapest hypothesis first.

    Each one changes what _systemInfo carries. pyatv's defaults are included as
    the baseline: if they answer, the identity is not the problem and the
    result says so instead of sending anyone off changing settings.
    """
    return [
        ("pyatv defaults (baseline)", {}),
        ("valid unicast device id", {"device_id": local_mac(seed), "mac": local_mac(seed)}),
        (
            "current iPhone, old ids",
            {"model": "iPhone17,1", "os_version": "26.0", "os_build": "23A341"},
        ),
        (
            "current iPhone, valid unicast ids",
            {
                "model": "iPhone17,1",
                "os_version": "26.0",
                "os_build": "23A341",
                "device_id": local_mac(seed),
                "mac": local_mac(seed),
                "name": "Navigator Panel",
            },
        ),
        (
            "current iPad, valid unicast ids",
            {
                "model": "iPad14,3",
                "os_version": "26.0",
                "os_build": "23A341",
                "device_id": local_mac(seed, 0x06),
                "mac": local_mac(seed, 0x06),
                "name": "Navigator Panel",
            },
        ),
    ]


async def identities(host: str, storage_file: str, identifier: str | None, debug: bool) -> int:
    """Find out which client identity this Apple TV will answer.

    A Companion connect opens with _systemInfo, which says who we are. When a
    device stops answering it after a tvOS update — the buttons stop working and
    nothing says why — the question is whether it dislikes what we claim to be.
    This tries each candidate against the real device, Companion only, and
    reports which ones got a reply. Nothing is written; set the winner with the
    APPLE_TV_CLIENT_* variables.

        docker exec navigator-panel /opt/pyatv/bin/python \\
          /app/dist/apple-tv-bridge.py --identities 192.168.1.50 /config/apple-tv.json
    """
    if debug:
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)

    loop = asyncio.get_running_loop()
    storage = FileStorage(storage_file, loop)
    Path(storage_file).parent.mkdir(parents=True, exist_ok=True)
    await storage.load()

    def say(message: str = "") -> None:
        print(message, flush=True)

    say(f"Trying client identities against {host}")
    say("Companion only, nothing written, nothing shown on the TV.\n")

    found = await pyatv.scan(
        loop, timeout=SCAN_TIMEOUT, hosts=[host], identifier=identifier, storage=storage
    )
    if not found:
        say(f"Nothing answered at {host}.")
        return 1
    config = found[0]
    if config.get_service(Protocol.Companion) is None:
        say("This Apple TV does not advertise Companion, so there is nothing to try.")
        return 1

    settings = await storage.get_settings(config)
    original = {field: getattr(settings.info, field) for field in CLIENT_FIELDS}
    winners: list[str] = []
    try:
        for label, overrides in candidate_identities(str(config.identifier or host)):
            for field, value in original.items():
                setattr(settings.info, field, value)
            for field, value in overrides.items():
                setattr(settings.info, field, value)
            atv, session, elapsed, error = await attempt(
                loop, storage, config, PROBE_CONNECT_TIMEOUT, {Protocol.Companion}
            )
            if error is None:
                winners.append(label)
                say(f"OK    {label}: answered in {elapsed:.1f}s")
                atv.close()
                if session is not None:
                    await session.close()
            else:
                say(f"FAIL  {label}: {describe(error)} after {elapsed:.1f}s")
            if overrides:
                say(f"      {overrides}")
    finally:
        for field, value in original.items():
            setattr(settings.info, field, value)

    say()
    if not winners:
        say("None of them answered, so the identity is not what this Apple TV is")
        say("objecting to. Check --probe first: if it reports a routing problem,")
        say("fix that before reading anything here.")
        return 1
    if winners[0].startswith("pyatv defaults"):
        say("The defaults answered, so the identity is not the problem here.")
        return 0
    say(f"Answered: {', '.join(winners)}.")
    say("Set the matching APPLE_TV_CLIENT_* variables on the container, for example:")
    for label, overrides in candidate_identities(str(config.identifier or host)):
        if label == winners[0]:
            for field, value in overrides.items():
                say(f"  APPLE_TV_CLIENT_{field.upper()}={value}")
            break
    say("then restart it and run --probe again.")
    return 0


async def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--debug"]
    debug = "--debug" in sys.argv
    if len(args) > 1 and args[0] == "--identities":
        sys.exit(await identities(
            args[1],
            args[2] if len(args) > 2 else "/config/apple-tv.json",
            args[3] if len(args) > 3 else None,
            debug,
        ))
    if len(args) > 1 and args[0] == "--pair":
        sys.exit(await pair_cli(
            args[1],
            args[2] if len(args) > 2 else "/config/apple-tv.json",
            args[4] if len(args) > 4 else None,
            args[3] if len(args) > 3 else None,
            debug,
        ))
    if len(args) > 1 and args[0] == "--probe":
        sys.exit(await probe(
            args[1],
            args[2] if len(args) > 2 else "/config/apple-tv.json",
            args[3] if len(args) > 3 else None,
            debug,
        ))
    storage_file = args[0] if args else "/config/apple-tv.json"
    bridge = Bridge(storage_file)
    await bridge.start()
    # Requests run concurrently. Handling them one at a time meant a command
    # the Apple TV never answered blocked every press behind it, so a single
    # wedged call made the whole remote look dead.
    running: set[asyncio.Task[Any]] = set()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                emit({"t": "response", "id": None, "ok": False, "error": "Invalid JSON"})
                continue
            task = asyncio.create_task(bridge.request(message))
            running.add(task)
            task.add_done_callback(running.discard)
    finally:
        for task in list(running) + list(bridge.background):
            task.cancel()
        if bridge.poller:
            bridge.poller.cancel()
        await asyncio.gather(*(bridge.close_device(d) for d in bridge.devices.values()))


if __name__ == "__main__":
    asyncio.run(main())
