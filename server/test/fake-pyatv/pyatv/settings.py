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


class Info:
    def __init__(self):
        self.name = "pyatv"
        self.model = "iPhone10,6"
        self.device_id = "FF:70:79:61:74:76"
        self.mac = "02:70:79:61:74:76"
        self.rp_id = "cafecafecafe"
        self.os_name = "iPhone OS"
        self.os_build = "18G82"
        self.os_version = "14.7.1"


class Settings:
    def __init__(self):
        self.protocols = Protocols()
        self.info = Info()
