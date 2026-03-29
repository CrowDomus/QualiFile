"""Two-phase PPS import plan and confirmation guards."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, TypeVar

from .pps_manifest import ENTRIES_DIRNAME, PROJECT_FILENAME, TAG_DEFINITIONS_DIRNAME
from .pps_serializer import PPS_JSON_ENCODING

DEFAULT_LARGE_DELETE_THRESHOLD = 20
_PROJECT_ID_KEYS = ("project_id", "id")

T = TypeVar("T")


class ImportPlanError(RuntimeError):
    """Raised when two-phase import plan generation/confirmation fails."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


def _normalize_required_text(value: Any, *, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ImportPlanError("import-plan-invalid-payload", f"{label} must be a non-empty string.")
    return text


def required_force_import_phrase(project_id: str) -> str:
    """Return the exact typed phrase required for force-import confirmation."""

    return f"IMPORT {_normalize_required_text(project_id, label='project_id')}"


def is_force_import_phrase_match(
    *,
    project_id: str,
    typed_confirmation: str | None,
) -> bool:
    """Check spec-accurate force-import phrase matching rules."""

    if typed_confirmation is None:
        return False
    normalized_typed = str(typed_confirmation).strip()
    return normalized_typed == required_force_import_phrase(project_id)


def enforce_force_import_phrase(
    *,
    project_id: str,
    typed_confirmation: str | None,
) -> None:
    """Block force import unless the typed phrase exactly matches `IMPORT <project_id>`."""

    expected = required_force_import_phrase(project_id)
    if is_force_import_phrase_match(project_id=project_id, typed_confirmation=typed_confirmation):
        return
    raise ImportPlanError(
        "import-force-confirmation-required",
        "Force Import requires exact typed confirmation before apply.",
        details=[f"required_phrase={expected}"],
    )


@dataclass(frozen=True)
class EntityChangeSet:
    add: tuple[str, ...]
    update: tuple[str, ...]
    delete: tuple[str, ...]

    @property
    def add_count(self) -> int:
        return len(self.add)

    @property
    def update_count(self) -> int:
        return len(self.update)

    @property
    def delete_count(self) -> int:
        return len(self.delete)


@dataclass(frozen=True)
class ImportPlan:
    project: EntityChangeSet
    tags: EntityChangeSet
    entries: EntityChangeSet

    @property
    def total_add_count(self) -> int:
        return self.project.add_count + self.tags.add_count + self.entries.add_count

    @property
    def total_update_count(self) -> int:
        return self.project.update_count + self.tags.update_count + self.entries.update_count

    @property
    def total_delete_count(self) -> int:
        return self.project.delete_count + self.tags.delete_count + self.entries.delete_count

    def summary(self) -> dict[str, Any]:
        return {
            "project": {
                "add": self.project.add_count,
                "update": self.project.update_count,
                "delete": self.project.delete_count,
            },
            "tags": {
                "add": self.tags.add_count,
                "update": self.tags.update_count,
                "delete": self.tags.delete_count,
            },
            "entries": {
                "add": self.entries.add_count,
                "update": self.entries.update_count,
                "delete": self.entries.delete_count,
            },
            "totals": {
                "add": self.total_add_count,
                "update": self.total_update_count,
                "delete": self.total_delete_count,
            },
        }


def _canonical_payload(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _normalize_mapping(value: Mapping[str, Any] | None, *, label: str) -> Mapping[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ImportPlanError("import-plan-invalid-payload", f"{label} must be an object.")
    return value


def _extract_project_id(payload: Mapping[str, Any], *, label: str) -> str:
    for key in _PROJECT_ID_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ImportPlanError("import-plan-missing-project-id", f"{label} must include project_id.")


def _extract_entity_id(payload: Mapping[str, Any], *, label: str, index: int) -> str:
    entity_id = payload.get("id")
    if not isinstance(entity_id, str) or not entity_id.strip():
        raise ImportPlanError("import-plan-missing-entity-id", f"{label}[{index}] is missing a valid 'id'.")
    return entity_id.strip()


def _map_entities_by_id(items: Sequence[Mapping[str, Any]] | None, *, label: str) -> dict[str, Mapping[str, Any]]:
    mapped: dict[str, Mapping[str, Any]] = {}
    for index, item in enumerate(items or ()):
        if not isinstance(item, Mapping):
            raise ImportPlanError("import-plan-invalid-payload", f"{label}[{index}] must be an object.")
        entity_id = _extract_entity_id(item, label=label, index=index)
        if entity_id in mapped:
            raise ImportPlanError("import-plan-duplicate-entity-id", f"{label} contains duplicate id '{entity_id}'.")
        mapped[entity_id] = item
    return mapped


def _diff_project(
    incoming_project: Mapping[str, Any] | None,
    local_project: Mapping[str, Any] | None,
) -> EntityChangeSet:
    if incoming_project is None and local_project is None:
        return EntityChangeSet(add=tuple(), update=tuple(), delete=tuple())

    if incoming_project is None and local_project is not None:
        local_id = _extract_project_id(local_project, label="local_project")
        return EntityChangeSet(add=tuple(), update=tuple(), delete=(local_id,))

    if incoming_project is not None and local_project is None:
        incoming_id = _extract_project_id(incoming_project, label="incoming_project")
        return EntityChangeSet(add=(incoming_id,), update=tuple(), delete=tuple())

    assert incoming_project is not None
    assert local_project is not None
    incoming_id = _extract_project_id(incoming_project, label="incoming_project")
    local_id = _extract_project_id(local_project, label="local_project")

    if incoming_id != local_id:
        return EntityChangeSet(add=(incoming_id,), update=tuple(), delete=(local_id,))

    if _canonical_payload(incoming_project) == _canonical_payload(local_project):
        return EntityChangeSet(add=tuple(), update=tuple(), delete=tuple())
    return EntityChangeSet(add=tuple(), update=(incoming_id,), delete=tuple())


def _diff_entities(
    *,
    incoming_items: Sequence[Mapping[str, Any]] | None,
    local_items: Sequence[Mapping[str, Any]] | None,
    label: str,
) -> EntityChangeSet:
    incoming_by_id = _map_entities_by_id(incoming_items, label=f"incoming_{label}")
    local_by_id = _map_entities_by_id(local_items, label=f"local_{label}")

    incoming_ids = set(incoming_by_id)
    local_ids = set(local_by_id)

    add = tuple(sorted(incoming_ids - local_ids))
    delete = tuple(sorted(local_ids - incoming_ids))
    update_candidates = sorted(incoming_ids & local_ids)
    update = tuple(
        entity_id
        for entity_id in update_candidates
        if _canonical_payload(incoming_by_id[entity_id]) != _canonical_payload(local_by_id[entity_id])
    )
    return EntityChangeSet(add=add, update=update, delete=delete)


def load_pps_snapshot_entities(snapshot_dir: Path | str) -> tuple[Mapping[str, Any], list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """Load project/tag/entry entities from a PPS snapshot directory."""

    snapshot = Path(snapshot_dir)
    project_path = snapshot / PROJECT_FILENAME
    if not project_path.exists():
        raise ImportPlanError("import-plan-project-missing", "project.json is missing from snapshot.")

    try:
        project_payload = json.loads(project_path.read_text(encoding=PPS_JSON_ENCODING))
    except Exception as exc:
        raise ImportPlanError("import-plan-project-invalid-json", "project.json is invalid JSON.") from exc
    if not isinstance(project_payload, Mapping):
        raise ImportPlanError("import-plan-project-invalid-shape", "project.json must be an object.")

    def _load_entity_list(path: Path, *, label: str) -> list[Mapping[str, Any]]:
        if not path.exists() or not path.is_dir():
            raise ImportPlanError(
                "import-plan-required-path-missing",
                f"Snapshot directory is missing: {path.name}",
                details=[label],
            )
        loaded: list[Mapping[str, Any]] = []
        for file_path in sorted(path.glob("*.json"), key=lambda item: item.name):
            try:
                payload = json.loads(file_path.read_text(encoding=PPS_JSON_ENCODING))
            except Exception as exc:
                raise ImportPlanError(
                    "import-plan-entity-invalid-json",
                    f"Invalid JSON in {label} entity: {file_path.name}",
                    details=[file_path.name],
                ) from exc
            if not isinstance(payload, Mapping):
                raise ImportPlanError(
                    "import-plan-entity-invalid-shape",
                    f"Entity payload must be an object: {file_path.name}",
                    details=[file_path.name],
                )
            loaded.append(payload)
        return loaded

    tags = _load_entity_list(snapshot / TAG_DEFINITIONS_DIRNAME, label="tag_definitions")
    entries = _load_entity_list(snapshot / ENTRIES_DIRNAME, label="entries")
    return project_payload, tags, entries


def build_import_plan(
    *,
    incoming_project: Mapping[str, Any] | None,
    incoming_tags: Sequence[Mapping[str, Any]] | None,
    incoming_entries: Sequence[Mapping[str, Any]] | None,
    local_project: Mapping[str, Any] | None,
    local_tags: Sequence[Mapping[str, Any]] | None,
    local_entries: Sequence[Mapping[str, Any]] | None,
) -> ImportPlan:
    """Create a deterministic add/update/delete plan for a PPS import."""

    normalized_incoming_project = _normalize_mapping(incoming_project, label="incoming_project")
    normalized_local_project = _normalize_mapping(local_project, label="local_project")

    return ImportPlan(
        project=_diff_project(normalized_incoming_project, normalized_local_project),
        tags=_diff_entities(incoming_items=incoming_tags, local_items=local_tags, label="tags"),
        entries=_diff_entities(incoming_items=incoming_entries, local_items=local_entries, label="entries"),
    )


def requires_large_delete_confirmation(
    plan: ImportPlan,
    *,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
) -> bool:
    if delete_threshold < 0:
        raise ValueError("delete_threshold must be non-negative.")
    return plan.total_delete_count > delete_threshold


def enforce_import_plan_confirmation(
    plan: ImportPlan,
    *,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    require_force_import_phrase: bool = False,
    force_import_project_id: str | None = None,
    force_import_typed_phrase: str | None = None,
) -> None:
    """Validate two-phase confirmation requirements before apply."""

    if not confirm_apply:
        raise ImportPlanError(
            "import-plan-confirmation-required",
            "Import apply is blocked until the user confirms the generated import plan.",
        )
    if requires_large_delete_confirmation(plan, delete_threshold=delete_threshold) and not confirm_large_delete:
        raise ImportPlanError(
            "import-large-delete-confirmation-required",
            (
                "Import delete count exceeds safety threshold; explicit large-delete confirmation is required "
                "before apply."
            ),
            details=[f"delete_threshold={delete_threshold}", f"delete_count={plan.total_delete_count}"],
        )
    if require_force_import_phrase:
        if force_import_project_id is None:
            raise ImportPlanError(
                "import-force-project-id-required",
                "Force Import confirmation requires a target project_id.",
            )
        enforce_force_import_phrase(
            project_id=force_import_project_id,
            typed_confirmation=force_import_typed_phrase,
        )


def execute_two_phase_import_apply(
    plan: ImportPlan,
    *,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    require_force_import_phrase: bool = False,
    force_import_project_id: str | None = None,
    force_import_typed_phrase: str | None = None,
    apply_fn: Callable[[ImportPlan], T] | None = None,
) -> T | None:
    """Run apply callback only when two-phase confirmation guards pass."""

    enforce_import_plan_confirmation(
        plan,
        confirm_apply=confirm_apply,
        confirm_large_delete=confirm_large_delete,
        delete_threshold=delete_threshold,
        require_force_import_phrase=require_force_import_phrase,
        force_import_project_id=force_import_project_id,
        force_import_typed_phrase=force_import_typed_phrase,
    )
    if apply_fn is None:
        return None
    return apply_fn(plan)


__all__ = [
    "DEFAULT_LARGE_DELETE_THRESHOLD",
    "EntityChangeSet",
    "ImportPlan",
    "ImportPlanError",
    "build_import_plan",
    "enforce_force_import_phrase",
    "enforce_import_plan_confirmation",
    "is_force_import_phrase_match",
    "execute_two_phase_import_apply",
    "load_pps_snapshot_entities",
    "required_force_import_phrase",
    "requires_large_delete_confirmation",
]
