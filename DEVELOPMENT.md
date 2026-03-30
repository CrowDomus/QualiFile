# Development

## Environment

- Python 3.10 or newer
- Windows recommended for full feature coverage
- `pip install -r requirements.txt` for source runs
- `pip install -r requirements/tools.txt` to rebuild minified assets
- `pip install -r requirements/portable_build.txt` for portable packaging

## Run Locally

```bash
python -m flask --app run.py --debug run
```

The app starts on `127.0.0.1:5000` by default and creates runtime data under
the active instance/data directory.

## Build Portable Packages

Windows-only build entry points:

```bash
build_portable.bat
build_portable_embedded.bat
```

These scripts install build dependencies, vendor offline assets, rebuild
frontend bundles, and package the launcher/server with PyInstaller.

## Validate Source

```bash
python -m compileall run.py app packaging tools
```

## Project Layout

- `app/` runtime code
- `docs/` tutorial, schema, and portable notices
- `packaging/` launchers and PyInstaller specs
- `tools/` asset and packaging helpers
- `requirements/` dependency groups
