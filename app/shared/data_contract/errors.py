"""Shared errors for data contract tooling."""

from __future__ import annotations


class DataContractError(Exception):
    """Base error for data contract tooling."""


class YamlParseError(DataContractError):
    """Raised when the minimal YAML loader cannot parse input."""


class RegistryValidationError(DataContractError):
    """Raised when the schema registry fails validation."""

    def __init__(self, message: str, *, errors: list[str] | None = None):
        super().__init__(message)
        self.errors = errors or []
