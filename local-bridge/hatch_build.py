"""Bundle the built viewer into the package before packing.

Wheels and sdists must carry the app so `pip install ifcviewx` serves the
viewer with no Node step. Building from the repo needs `npm run build` first
(the repo's dist/ is copied in); building from an sdist reuses the copy the
sdist already ships. Editable installs skip all of this: the service falls
back to the checkout's dist/ at runtime.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class AppBundleHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        if self.target_name == "editable":
            return
        app = Path(self.root) / "src" / "ifcviewx" / "app"
        dist = Path(self.root).parent / "dist"
        if (dist / "index.html").is_file():
            shutil.rmtree(app, ignore_errors=True)
            shutil.copytree(dist, app)
        if not (app / "index.html").is_file():
            raise RuntimeError("no built viewer to bundle: run `npm run build` at the repo root first")
