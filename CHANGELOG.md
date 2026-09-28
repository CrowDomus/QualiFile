# Changelog

All notable changes to this project are documented in this file.

## 1.3.1 - 2026-09-28

- Fix blank previews of larger PDFs and Office-generated PDFs while preserving document isolation.
- Keep preview warnings compact and contained within the preview pane.
- Remove merge file-count and aggregate size limits, process image pages incrementally and serialize merges.
- Preserve existing output files when a merge fails.
- Show per-file annotation progress with concise summaries and expandable failure details.
- Add an off-by-default setting to replace matching filenames on capture and merge. Replaced captures retain image history.
- Update the offline tutorial.

## 1.3.0 - 2026-09-27

- Remember the current workspace folder across browser refreshes and improve the project workspace selector.
- Copy annotations from a reference image to one or multiple images, with reference preview, visible selection and optional preservation of existing annotations.
- Navigate between images in the annotation tool with save or discard prompts, and refresh the preview after saving.
- Keep automatic image history in internal application storage and restore previous versions with previews while preserving tags.
- Improve modal close controls, annotation toolbar labels and capture controls.
- Preserve successfully exported Word previews when document cleanup disconnects, and restart the affected preview session.
- Accelerate uncached Office previews with a controlled reusable Office session, bounded waits and cleanup. Existing Fast and Standard quality modes remain available, and acceleration can be disabled in Settings.
- Harden local request validation, OS capabilities, logging privacy, file target containment and overwrite recovery.
- Update PDF processing to pypdf 6.15.0 and refresh the offline user tutorial.

## [1.0.0] - 2026-03-29

### Added

- Initial production release of QualiFile
- Workspace explorer, previews, PDF/image tooling, notes, tags, and validation flows
- Projects, timeline, alerts, and Git Sync Manager
- Windows portable and embedded portable packaging

### Fixed

- Release alignment for versioning, documentation, and runtime request size defaults
