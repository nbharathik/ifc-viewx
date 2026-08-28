"""Verify a built wheel's bundled app and dependency-free CLI entry points."""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


REQUIRED_SUFFIXES = (
    "ifcviewx/app/index.html",
    "ifcviewx/app/wasm/web-ifc.wasm",
    ".dist-info/licenses/LICENSE",
    ".dist-info/licenses/LICENSE-MPL-2.0",
    ".dist-info/licenses/NOTICE",
)
FORBIDDEN_PREFIXES = ("ifcviewx/app/docs/",)


def _python(environment: Path) -> Path:
    return environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test an ifcviewx wheel in a clean virtual environment")
    parser.add_argument("wheel", type=Path, help="wheel file or directory containing wheels")
    args = parser.parse_args()
    wheel = args.wheel.resolve(strict=True)
    if wheel.is_dir():
        wheels = sorted(wheel.glob("*.whl"), key=lambda path: path.stat().st_mtime)
        if not wheels:
            raise SystemExit(f"no wheel found in {wheel}")
        wheel = wheels[-1]

    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
    missing = [suffix for suffix in REQUIRED_SUFFIXES if not any(name.endswith(suffix) for name in names)]
    if missing:
        raise SystemExit(f"wheel is missing: {', '.join(missing)}")
    unexpected = [prefix for prefix in FORBIDDEN_PREFIXES if any(name.startswith(prefix) for name in names)]
    if unexpected:
        raise SystemExit(f"wheel contains generated documentation: {', '.join(unexpected)}")

    with tempfile.TemporaryDirectory(prefix="ifcviewx-wheel-") as directory:
        environment = Path(directory) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = _python(environment)
        subprocess.run(
            [str(python), "-m", "pip", "install", "--no-deps", str(wheel)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        probes = (
            "import ifcviewx; from pathlib import Path; assert (Path(ifcviewx.__file__).parent / 'app' / 'index.html').is_file()",
            "import sys; from ifcviewx.cli import main; sys.argv=['ifcviewx','--help']; main()",
            "import sys; from ifcviewx.check import run; raise SystemExit(run(['--help']))",
            "import sys; from ifcviewx.convert import main; sys.argv=['ifcx-convert','--help']; main()",
        )
        for probe in probes:
            subprocess.run(
                [str(python), "-c", probe],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
    print(f"wheel smoke passed: {wheel.name}")


if __name__ == "__main__":
    main()
