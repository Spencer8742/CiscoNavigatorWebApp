"""Constants mirroring the subset of pyatv.const that bridge.py imports."""

from enum import Enum


class Protocol(Enum):
    DMAP = 1
    MRP = 2
    AirPlay = 3
    Companion = 4
    RAOP = 5


class PairingRequirement(Enum):
    Unsupported = 1
    Disabled = 2
    NotNeeded = 3
    Optional = 4
    Mandatory = 5


class PowerState(Enum):
    Unknown = 0
    Off = 1
    On = 2


class DeviceState(Enum):
    Idle = 0
    Loading = 1
    Stopped = 3
    Paused = 4
    Playing = 5
    Seeking = 6


class MediaType(Enum):
    Unknown = 0
    Video = 1
    Music = 2
    TV = 3
