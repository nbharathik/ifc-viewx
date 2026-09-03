<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/logo/lockup-dark.svg">
    <img src="../assets/logo/lockup-light.svg" alt="IFCViewX" width="360">
  </picture>
</p>

<p align="center">
  Local IFC tools for IFCViewX. Everything stays on your machine.
  <br>
  <a href="https://ifcviewx.com/docs/local-studio/"><strong>Local Studio guide</strong></a>
  &middot;
  <a href="https://ifcviewx.com/docs/">Docs</a>
</p>

## Install and run

```bash
pip install ifcviewx
ifcviewx                     # open Local Studio
ifcviewx model.ifc           # open a model
```

Local Studio serves IFCViewX at `127.0.0.1:8765`. It can convert IFC models to
`.ifcx` with IfcOpenShell, run native Python, and check models from the command
line. It also provides an MCP bridge for supported AI clients and can keep an
assistant API key in a local vault instead of the browser.

Use `--convert` when you want to create an optimized `.ifcx` copy. The `check`
command runs model and IDS checks without opening the viewer, while `mcp`
starts the bridge for an AI client.

```bash
ifcviewx model.ifc --convert
ifcviewx check model.ifc --ids spec.ids
ifcviewx mcp
```

The service accepts local connections only. Model edits run on a copy and wait
for approval in the viewer, so the original file is not changed silently. Use
`--readonly` to block writes or `--no-python` to disable Python completely.

## License

Apache License 2.0, see [LICENSE](../LICENSE).
