"""A fake Apple TV that can be told to misbehave the way a real one does.

The bridge is the code under test: these tests import nothing from it, they
run `server/src/apple-tv/bridge.py` as a real subprocess with this package
ahead of the real pyatv on PYTHONPATH. Behaviour is read fresh from the JSON
file named by FAKE_ATV_CONTROL on every call, so a test can leave a device
healthy, wedge it mid-session the way a tvOS upgrade does, and watch what
the bridge makes of it.
"""

import asyncio
import json
import os
from typing import Any

import aiohttp

from pyatv import exceptions
from pyatv.const import (
    DeviceState,
    MediaType,
    PairingRequirement,
    PowerState,
    Protocol,
)

__all__ = ["scan", "connect", "pair", "exceptions"]


def control() -> dict:
    """Read the scenario. Fresh every call so tests can change it mid-run."""
    path = os.environ.get("FAKE_ATV_CONTROL")
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def note(event: str, **fields: Any) -> None:
    """Append to the call log so tests can assert on what the bridge did."""
    path = os.environ.get("FAKE_ATV_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, **fields}) + "\n")


async def misbehave(mode: str, what: str, atv: "AppleTV | None" = None) -> None:
    """Fail the way the control file asks."""
    if atv is not None and atv.dead:
        # A handle whose session died stays dead however the scenario changes.
        raise ConnectionResetError()
    if mode in ("ok", "", None):
        return
    if mode == "hang":
        await asyncio.sleep(3600)
    if mode == "auth":
        raise exceptions.AuthenticationError()
    if mode == "invalid-credentials":
        raise exceptions.InvalidCredentialsError()
    if mode == "reset":
        if atv is not None:
            atv.dead = True
        raise ConnectionResetError()
    if mode == "timeout":
        raise asyncio.TimeoutError()
    if mode == "protocol":
        raise exceptions.ProtocolError()
    if mode == "no-handler":
        raise exceptions.ProtocolError(f"Command {what} failed")
    raise RuntimeError(mode)


class Service:
    def __init__(self, protocol, credentials=None, pairing=PairingRequirement.Mandatory):
        self.protocol = protocol
        self.credentials = credentials
        self.pairing = pairing


class Config:
    def __init__(self, host, identifier, services):
        self.address = host
        self.identifier = identifier
        self.name = "Fake Apple TV"
        self._services = {service.protocol: service for service in services}

    def get_service(self, protocol):
        return self._services.get(protocol)


class Artwork:
    def __init__(self):
        self.bytes = b"\x89PNG\r\n\x1a\n" + b"0" * 64
        self.mimetype = "image/png"


class Playing:
    def __init__(self, state):
        self.device_state = DeviceState[state.get("deviceState", "Playing")]
        self.media_type = MediaType[state.get("mediaType", "Video")]
        self.title = state.get("title", "Test Title")
        self.artist = state.get("artist")
        self.album = state.get("album")
        self.position = state.get("position", 10)
        self.total_time = state.get("duration", 100)
        self.hash = state.get("hash", "hash-1")


class Metadata:
    def __init__(self, atv):
        self.atv = atv

    @property
    def app(self):
        name = control().get("app", "Fake App")
        return type("App", (), {"name": name, "identifier": "com.fake.app"})()

    @property
    def artwork_id(self):
        return control().get("artworkId", "art-1")

    async def artwork(self, width=None, height=None):
        return Artwork()

    async def playing(self):
        await misbehave(control().get("playing", "ok"), "playing", self.atv)
        return Playing(control().get("state", {}))


class RemoteControl:
    def __init__(self, atv):
        self.atv = atv

    def __getattr__(self, op):
        async def press():
            note("command", op=op)
            await misbehave(control().get("command", "ok"), op, self.atv)
            self.atv.pressed.append(op)

        return press


class Power:
    def __init__(self, atv):
        self.atv = atv
        self.listener = None

    @property
    def power_state(self):
        return PowerState[control().get("power", "On")]

    async def turn_on(self):
        note("command", op="power_on")
        await misbehave(control().get("command", "ok"), "power_on", self.atv)
        self.atv.pressed.append("power_on")

    async def turn_off(self):
        note("command", op="power_off")
        await misbehave(control().get("command", "ok"), "power_off", self.atv)
        self.atv.pressed.append("power_off")


class Touch:
    def __init__(self, atv):
        self.atv = atv

    async def swipe(self, start_x, start_y, end_x, end_y, duration):
        note("swipe", args=[start_x, start_y, end_x, end_y, duration])
        await misbehave(control().get("command", "ok"), "swipe", self.atv)
        self.atv.pressed.append("swipe")


class Apps:
    def __init__(self, atv):
        self.atv = atv

    async def app_list(self):
        await misbehave(control().get("appList", "ok"), "app_list", self.atv)
        return [
            type("App", (), {"identifier": identifier, "name": identifier})()
            for identifier in control().get("apps", ["com.fake.app"])
        ]

    async def launch_app(self, identifier):
        note("launch", app=identifier)
        await misbehave(control().get("command", "ok"), "launch_app", self.atv)
        self.atv.pressed.append(f"launch:{identifier}")


class PushUpdater:
    def __init__(self):
        self.listener = None
        self.started = False

    def start(self):
        self.started = True

    def stop(self):
        self.started = False


class AppleTV:
    def __init__(self):
        self.listener = None
        self.push_updater = PushUpdater()
        self.metadata = Metadata(self)
        self.remote_control = RemoteControl(self)
        self.power = Power(self)
        self.touch = Touch(self)
        self.apps = Apps(self)
        self.pressed: list[str] = []
        self.closed = False
        self.dead = False

    def close(self):
        self.closed = True
        note("close")


class Pairing:
    def __init__(self, protocol):
        self.protocol = protocol
        self.has_paired = False
        self._pin = None

    @property
    def device_provides_pin(self):
        # True for the protocols that put a code on the TV, which is all of
        # them here unless a scenario says otherwise.
        return control().get("devicePin", True)

    async def begin(self):
        note("pair-begin", protocol=self.protocol.name)

    def pin(self, value):
        self._pin = value

    async def finish(self):
        self.has_paired = self._pin == control().get("pin", "1234")

    async def close(self):
        note("pair-close")


async def scan(loop, timeout=5, hosts=None, identifier=None, storage=None):
    note("scan", hosts=hosts)
    settings = control()
    await misbehave(settings.get("scan", "ok"), "scan")
    if settings.get("scanEmpty"):
        return []
    credentials = settings.get("credentials", {"companion": True, "airplay": True})
    return [
        Config(
            hosts[0] if hosts else "10.0.0.1",
            identifier or "AA:BB:CC:DD:EE:FF",
            [
                Service(
                    Protocol.Companion,
                    "companion-creds" if credentials.get("companion") else None,
                ),
                Service(
                    Protocol.AirPlay,
                    "airplay-creds" if credentials.get("airplay") else None,
                ),
            ],
        )
    ]


async def connect(config, loop, storage=None, protocol=None, session=None):
    settings = await storage.get_settings(config) if storage is not None else None
    tunnel = getattr(settings.protocols.airplay, "mrp_tunnel", None) if settings else None
    note("connect", tunnel=getattr(tunnel, "value", None))
    if control().get("tunnel") == "fail" and getattr(tunnel, "value", None) != "disable":
        # What pyatv raises when the MRP-over-AirPlay tunnel will not start.
        raise exceptions.ProtocolError(
            "Failed to set up remote control channel"
        ) from exceptions.HttpError()
    # Faithful to pyatv: when it is not handed a session it makes its own, and
    # it reclaims that one in a handler guarded by `except Exception`. A
    # caller's deadline cancels with CancelledError, which is not an Exception,
    # so that handler never runs and the session is orphaned.
    owned = session is None
    session = session or aiohttp.ClientSession()
    try:
        await misbehave(control().get("connect", "ok"), "connect")
    except Exception:
        if owned:
            await session.close()
        raise
    return AppleTV()


async def pair(config, protocol, loop, storage=None, **kwargs):
    await misbehave(control().get("pair", "ok"), "pair")
    return Pairing(protocol)
