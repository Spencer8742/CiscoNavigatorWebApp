"""Stand-in for pyatv.storage.file_storage.FileStorage."""

import json
from pathlib import Path

from pyatv.settings import Settings


class FileStorage:
    def __init__(self, filename, loop):
        self.filename = filename
        self.loop = loop
        self.saves = 0
        # A reference held by the storage, exactly as pyatv does it, so a
        # caller mutating what it gets back changes what the next connect sees.
        self._settings = Settings()

    async def get_settings(self, config):
        return self._settings

    async def load(self):
        path = Path(self.filename)
        if path.exists():
            try:
                json.loads(path.read_text())
            except ValueError:
                pass

    async def save(self):
        self.saves += 1
        path = Path(self.filename)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"saves": self.saves}))
