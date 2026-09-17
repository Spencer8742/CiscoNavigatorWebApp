"""Stand-in for pyatv.support.net.

The real one walks the machine's interfaces. Here the scenario decides, so a
test can put the bridge on a Docker bridge network without needing one.
"""

import json
import os
from ipaddress import IPv4Address
from typing import Optional


def _control() -> dict:
    path = os.environ.get("FAKE_ATV_CONTROL")
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def get_local_address_reaching(dest_ip: IPv4Address) -> Optional[IPv4Address]:
    """None when no local interface shares a subnet with dest_ip."""
    if _control().get("offSubnet"):
        return None
    return IPv4Address("192.168.0.2")
