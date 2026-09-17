#!/usr/bin/env python3
"""Persistent pyatv bridge. NDJSON on stdin/stdout; diagnostics stay on stderr."""

import asyncio
import base64
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

import pyatv
from pyatv import exceptions
from pyatv.const import PairingRequirement, Protocol
from pyatv.storage.file_storage import FileStorage

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
CONNECT_TIMEOUT = 8.0
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
        return message if device is None or name in message else f"{name}: {message}"
    # Last resort: the class name still beats an empty string.
    return f"{name} failed with {type(exc).__name__}."


def is_credential_problem(exc: BaseException) -> bool:
    return isinstance(exc, CREDENTIAL_ERRORS)


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
        await asyncio.gather(*(self.connect(d) for d in self.devices.values()))

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

    async def connect(self, device: Device) -> None:
        # One connect at a time per device: a command that hit a dead session
        # and the poller can both want one at the same moment.
        async with device.lock:
            if device.atv is not None or device.pairing is not None:
                return
            try:
                await asyncio.wait_for(self._open(device), CONNECT_TIMEOUT)
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
                device.config = None
                if is_credential_problem(exc):
                    self.credentials_rejected(device, None)
                device.error = describe(exc, device)
                trace(f"[{device.id}] connect failed: {device.error}")
        await self.publish(device)

    async def _open(self, device: Device) -> None:
        config = device.config
        if config is None:
            config = await self.scan(device)
        device.remote_paired, device.media_paired = self.pairing_status(config)
        device.paired = device.remote_paired and device.media_paired
        if device.pairing_state not in ("starting", "pin"):
            device.pairing_target = None if device.paired else ("remote" if not device.remote_paired else "media")
        atv = await pyatv.connect(config, self.loop, storage=self.storage)
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
            await self.connect(device)
        atv = device.atv
        if atv is None:
            raise RuntimeError(device.error or "Apple TV is not connected")
        try:
            return await asyncio.wait_for(action(atv), timeout)
        except Exception as exc:
            if not is_dropped_connection(exc):
                raise
            trace(f"[{device.id}] retrying after: {describe(exc, device)}")
            credentials = is_credential_problem(exc)
            await self.drop(device, atv, exc)
            await self.connect(device)
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
            await self.perform(device, "remote", lambda atv: getattr(atv.remote_control, op)())
        await self.publish(device)

    async def swipe(self, device: Device, message: dict[str, Any]) -> None:
        values = [message.get(key) for key in ("startX", "startY", "endX", "endY")]
        duration = message.get("durationMs")
        if not all(isinstance(value, int) and 0 <= value <= 1000 for value in values):
            raise RuntimeError("Swipe coordinates are invalid")
        if not isinstance(duration, int) or not 100 <= duration <= 2000:
            raise RuntimeError("Swipe duration is invalid")
        # A swipe is allowed to outlast its own duration on the wire.
        await self.perform(
            device,
            "remote",
            lambda atv: atv.touch.swipe(*values, duration),
            timeout=COMMAND_TIMEOUT + duration / 1000,
        )

    async def launch_app(self, device: Device, bundle_id: str, name: str) -> None:
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
        await self.connect(device)

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


async def probe(host: str, storage_file: str, identifier: str | None) -> int:
    """Report what an Apple TV actually offers, and what it refuses.

    Nothing here changes what is on screen: it scans, connects, and exercises
    the read paths that use the same sessions the remote does. Companion is
    what a tvOS update tends to break, and app_list() rides on it, so a
    Companion session that has stopped answering shows up here as a named
    failure rather than as a dead button in the panel.

        python3 apple-tv-bridge.py --probe 192.168.1.50 /config/apple-tv.json
    """
    loop = asyncio.get_running_loop()
    storage = FileStorage(storage_file, loop)
    Path(storage_file).parent.mkdir(parents=True, exist_ok=True)
    await storage.load()

    def line(status: str, message: str) -> None:
        print(f"{status:<6} {message}")

    print(f"Probing {host} (credentials from {storage_file})\n")

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

    try:
        atv = await asyncio.wait_for(pyatv.connect(config, loop, storage=storage), CONNECT_TIMEOUT)
    except Exception as exc:
        line("FAIL", f"connect: {describe(exc)}")
        line("INFO", "A rejected pairing here means the stored credentials no longer work; pair again.")
        return 1
    line("OK", "connected")

    failures = 0
    try:
        # Companion. This is the one a tvOS update usually takes out.
        try:
            apps = await asyncio.wait_for(atv.apps.app_list(), APP_TIMEOUT)
            line("OK", f"Companion answered: {len(apps)} apps installed")
        except Exception as exc:
            failures += 1
            line("FAIL", f"Companion (app list): {describe(exc)}")

        # MRP or AirPlay, which is what drives the now-playing card.
        try:
            playing = await asyncio.wait_for(atv.metadata.playing(), METADATA_TIMEOUT)
            line("OK", f"media session answered: {playing.device_state.name}")
        except Exception as exc:
            failures += 1
            line("FAIL", f"media session (now playing): {describe(exc)}")

        try:
            line("OK", f"power state: {atv.power.power_state.name}")
        except Exception as exc:
            line("WARN", f"power state unavailable: {describe(exc)}")
    finally:
        atv.close()

    print()
    if failures:
        print("Some sessions did not answer. If the pairing lines above say paired but a")
        print("session still fails, the Apple TV is holding credentials it no longer honours:")
        print("remove this device under Settings > General > AirPlay and HomeKit > ... and")
        print("pair it again from the panel.")
    else:
        print("Everything answered. The Apple TV is reachable and paired.")
    return 1 if failures else 0


async def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--probe":
        sys.exit(await probe(
            sys.argv[2],
            sys.argv[3] if len(sys.argv) > 3 else "/config/apple-tv.json",
            sys.argv[4] if len(sys.argv) > 4 else None,
        ))
    storage_file = sys.argv[1] if len(sys.argv) > 1 else "/config/apple-tv.json"
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
        for task in list(running):
            task.cancel()
        if bridge.poller:
            bridge.poller.cancel()
        await asyncio.gather(*(bridge.close_device(d) for d in bridge.devices.values()))


if __name__ == "__main__":
    asyncio.run(main())
