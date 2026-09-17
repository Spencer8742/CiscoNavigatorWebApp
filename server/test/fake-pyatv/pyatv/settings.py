"""The settings objects the bridge reaches into."""

from enum import Enum


class MrpTunnel(str, Enum):
    Auto = "auto"
    Force = "force"
    Disable = "disable"


class ProtocolSettings:
    def __init__(self):
        self.credentials = "stored"
        self.mrp_tunnel = MrpTunnel.Auto


class Protocols:
    def __init__(self):
        self.airplay = ProtocolSettings()
        self.companion = ProtocolSettings()
        self.raop = ProtocolSettings()
        self.mrp = ProtocolSettings()


class Settings:
    def __init__(self):
        self.protocols = Protocols()
