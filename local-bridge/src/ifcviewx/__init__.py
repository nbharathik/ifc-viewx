"""IFCViewX Local Studio: local service, converter and MCP bridge for the viewer."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("ifcviewx")
except PackageNotFoundError:
    __version__ = "0.0.0"
