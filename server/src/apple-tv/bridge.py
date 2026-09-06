#!/usr/bin/env python3
"""Persistent pyatv bridge. NDJSON on stdin/stdout; diagnostics stay on stderr."""

import asyncio
import base64
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyatv
from pyatv.const import PairingRequirement, Protocol
from pyatv.storage.file_storage import FileStorage


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":")), flush=True)


def text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


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


class Listener:
    def __init__(self, bridge: "Bridge", device: Device):
        self.bridge = bridge
        self.device = device

    def connection_lost(self, exception: Exception) -> None:
        self.device.atv = None
        self.device.error = str(exception)
        asyncio.create_task(self.bridge.publish(self.device))

    def connection_closed(self) -> None:
        self.device.atv = None
        asyncio.create_task(self.bridge.publish(self.device))

    def playstatus_update(self, updater: Any, playstatus: Any) -> None:
        asyncio.create_task(self.bridge.publish(self.device, playstatus))

    def playstatus_error(self, updater: Any, exception: Exception) -> None:
        self.device.error = str(exception)
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
            timeout=5,
            hosts=[device.host],
            identifier=device.identifier,
            storage=self.storage,
        )
        if not found:
            raise RuntimeError(f"No Apple TV answered at {device.host}")
        return found[0]

    async def connect(self, device: Device) -> None:
        if device.atv is not None or device.pairing is not None:
            return
        try:
            config = await self.scan(device)
            device.remote_paired, device.media_paired = self.pairing_status(config)
            device.paired = device.remote_paired and device.media_paired
            if device.pairing_state not in ("starting", "pin"):
                device.pairing_target = None if device.paired else ("remote" if not device.remote_paired else "media")
            atv = await pyatv.connect(config, self.loop, storage=self.storage)
            device.atv = atv
            device.error = None
            listener = Listener(self, device)
            atv.listener = listener
            atv.push_updater.listener = listener
            try:
                atv.power.listener = listener
            except Exception:
                pass
            atv.push_updater.start()
        except Exception as exc:  # network and protocol errors are state, not crashes
            device.atv = None
            device.error = str(exc)
        await self.publish(device)

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
                playing = await atv.metadata.playing()
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
                    artwork = await atv.metadata.artwork(width=640, height=None)
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
            "error": device.error,
        }
        # Node converts this monotonic stamp to wall time before publishing.
        emit({"t": "state", "state": state})

    async def command(self, device: Device, op: str) -> None:
        if device.atv is None:
            await self.connect(device)
        if device.atv is None:
            raise RuntimeError(device.error or "Apple TV is not connected")
        if op == "power_on":
            await device.atv.power.turn_on()
        elif op == "power_off":
            await device.atv.power.turn_off()
        else:
            allowed = {
                "up", "down", "left", "right", "select", "menu", "home",
                "play_pause", "play", "pause", "stop", "next", "previous",
                "skip_forward", "skip_backward", "volume_up", "volume_down", "screensaver",
            }
            if op not in allowed:
                raise RuntimeError("Unsupported Apple TV command")
            await getattr(device.atv.remote_control, op)()
        await self.publish(device)

    async def launch_app(self, device: Device, bundle_id: str, name: str) -> None:
        if device.atv is None:
            await self.connect(device)
        if device.atv is None:
            raise RuntimeError(device.error or "Apple TV is not connected")
        apps = await device.atv.apps.app_list()
        if not any(app.identifier == bundle_id for app in apps):
            raise RuntimeError(f"{name or bundle_id} is not installed on this Apple TV")
        await device.atv.apps.launch_app(bundle_id)
        await self.publish(device)

    async def pair_begin(self, device: Device) -> None:
        await self.close_device(device)
        device.pairing_state = "starting"
        device.error = None
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
            if device is not None:
                device.error = str(exc)
                device.pairing_state = "error" if str(message.get("t", "")).startswith("pair") else device.pairing_state
                await self.publish(device)
            emit({"t": "response", "id": request_id, "ok": False, "error": str(exc)})

    async def poll(self) -> None:
        while True:
            await asyncio.sleep(3)
            for device in list(self.devices.values()):
                if device.atv is None and device.pairing is None:
                    await self.connect(device)
                elif device.atv is not None:
                    await self.publish(device)


async def main() -> None:
    storage_file = sys.argv[1] if len(sys.argv) > 1 else "/config/apple-tv.json"
    bridge = Bridge(storage_file)
    await bridge.start()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            try:
                message = json.loads(line)
                await bridge.request(message)
            except json.JSONDecodeError:
                emit({"t": "response", "id": None, "ok": False, "error": "Invalid JSON"})
    finally:
        if bridge.poller:
            bridge.poller.cancel()
        await asyncio.gather(*(bridge.close_device(d) for d in bridge.devices.values()))


if __name__ == "__main__":
    asyncio.run(main())
