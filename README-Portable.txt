QualiFile Portable
===================

Usage
- Launch QualiFile.exe from this folder. It starts a local server on 127.0.0.1 and opens your default browser.
- On first launch, pick the workspace folder to manage. This choice is saved inside data/notes/root_state.json.
- To close the app, open Settings → Utilities → Exit QualiFile. This shuts down the local server so no background processes remain.

Data locations (all kept inside this folder)
- data/preview_cache: PDF/image previews generated on the fly.
- data/office_cache: Microsoft Office-to-PDF preview cache.
- data/notes: Root selection state and other small runtime files.
- activity.log: Written next to the data folder if logging is enabled.

Notes
- The server only listens on 127.0.0.1.
- Keep this folder together when moving or zipping the app.
- Source code is bundled inside the executables; static assets are shipped minified without source maps.
