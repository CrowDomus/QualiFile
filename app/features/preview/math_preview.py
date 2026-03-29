"""Pure math helpers used by the preview zoom UI."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Size:
    """Lightweight width/height tuple used for calculations."""

    width: float
    height: float

    def clamp_positive(self) -> "Size":
        """Avoid degenerate zero/negative dimensions."""

        return Size(max(self.width, 1e-6), max(self.height, 1e-6))


def rotated_dimensions(size: Size, rotation: int) -> Size:
    """Return bounding-box dimensions after rotating an image."""

    angle = rotation % 360
    if angle % 180 == 90:
        return Size(size.height, size.width).clamp_positive()
    return size.clamp_positive()


def fit_scale(container: Size, image: Size, rotation: int) -> float:
    """Return the scale required to fit ``image`` inside ``container``."""

    box = rotated_dimensions(image, rotation)
    container = container.clamp_positive()
    return min(container.width / box.width, container.height / box.height)


def max_zoom(container: Size, image: Size, rotation: int, base_scale: float) -> float:
    """Return an upper zoom bound that keeps the image visible."""

    container = container.clamp_positive()
    box = rotated_dimensions(image, rotation)
    base = max(base_scale, 1e-6)
    limit_w = container.width / (box.width * base)
    limit_h = container.height / (box.height * base)
    base_limit = max(1.0, min(limit_w, limit_h))
    return min(4.0, base_limit * 4.0)


def clamp_zoom(value: float, *, minimum: float, maximum: float) -> float:
    """Clamp zoom values to the provided bounds."""

    if minimum > maximum:
        minimum = maximum
    return max(minimum, min(maximum, value))

