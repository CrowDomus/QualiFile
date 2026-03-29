# QualiFile Production Source

This repository contains the QualiFile application source plus the files required to create the Windows portable builds.

## Run From Source

```bash
pip install -r requirements.txt
flask --app run.py run
```

## Build Portable Windows Packages

```bash
pip install -r requirements/portable_build.txt
build_portable.bat
build_portable_embedded.bat
```

## Notes

- The portable build downloads the offline web assets declared in `docs/portable_windows/vendor/vendor_manifest.json` when they are not already present locally.
- The in-app tutorial is served from `docs/user_tutorial/` and is bundled into the portable builds.
- Portable outputs are generated under `dist/` and are not part of the repository.
