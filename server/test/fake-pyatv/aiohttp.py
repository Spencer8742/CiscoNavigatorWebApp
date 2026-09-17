"""Stand-in for the part of aiohttp the bridge touches: the client session.

Real aiohttp lives in the pyatv virtualenv the bridge runs under in the image;
the tests run on a bare python3, so this supplies the one class involved and,
more usefully, records every session open and close. That is what lets a test
assert the bridge does not orphan a session when a connect times out.
"""

import json
import os


def _note(event: str, ident: int) -> None:
    path = os.environ.get("FAKE_ATV_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event, "session": ident}) + "\n")


class ClientSession:
    def __init__(self, *args, **kwargs):
        self.closed = False
        _note("session-open", id(self))

    async def close(self):
        if not self.closed:
            self.closed = True
            _note("session-close", id(self))
