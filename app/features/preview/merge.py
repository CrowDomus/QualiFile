"""Utilities that merge PDF and image content for QualiFile.

The helpers in this module encapsulate PDF/image manipulation so that the
Flask routes can remain thin.  Each function is accompanied by docstrings to
clarify intent for maintainers exploring the codebase.
"""

from __future__ import annotations

import math
from pathlib import Path
from textwrap import wrap
from typing import Dict, Iterable, List, Mapping, Tuple

from PIL import Image, ImageDraw, ImageFont, ImageOps
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
)

# Pillow renamed ``ANTIALIAS`` to ``Resampling.LANCZOS`` in newer releases.  A
# small compatibility shim keeps the rest of the module tidy.
try:  # pragma: no cover - attribute presence depends on Pillow version
    RESAMPLE = Image.Resampling.LANCZOS  # type: ignore[attr-defined]
except AttributeError:  # pragma: no cover
    RESAMPLE = Image.ANTIALIAS  # type: ignore[attr-defined]


class MergeError(RuntimeError):
    """Raised when merge operations cannot be completed safely."""


DEFAULT_PHRASE_FONT_SIZE_PT = 14.0
MIN_PHRASE_FONT_SIZE_PT = 6.0
MAX_PHRASE_FONT_SIZE_PT = 48.0


def merge_pdfs(paths: Iterable[Path], output: Path, *, page_numbers: bool = False) -> Path:
    """Merge the supplied PDF ``paths`` into ``output``."""

    writer = PdfWriter()
    for path in paths:
        reader = PdfReader(str(path))
        for page in reader.pages:
            writer.add_page(page)
    if page_numbers and writer.pages:
        _apply_pdf_page_numbers(writer)
    with output.open("wb") as handle:
        writer.write(handle)
    return output


def extract_pdf_pages(source: Path, output: Path, pages: List[int]) -> Path:
    """Create a PDF containing the specified ``pages`` (1-indexed) from ``source``."""

    reader = PdfReader(str(source))
    total_pages = len(reader.pages)
    if not pages:
        raise MergeError("Select at least one page.")
    writer = PdfWriter()
    for page in pages:
        if page < 1 or page > total_pages:
            raise MergeError(f"Page {page} is outside the range 1-{total_pages}.")
        writer.add_page(reader.pages[page - 1])
    with output.open("wb") as handle:
        writer.write(handle)
    return output


def _load_font(size: int = 14) -> ImageFont.ImageFont:
    """Return a readable font for PDF captions."""

    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except Exception:  # pragma: no cover - fallback is deterministic
        return ImageFont.load_default()


def _normalize_phrase_font_size_pt(value: float | int | None) -> float:
    """Return a safe phrase font size in points."""

    if value is None:
        return DEFAULT_PHRASE_FONT_SIZE_PT
    parsed = float(value)
    if not math.isfinite(parsed):
        return DEFAULT_PHRASE_FONT_SIZE_PT
    if parsed < MIN_PHRASE_FONT_SIZE_PT:
        return MIN_PHRASE_FONT_SIZE_PT
    if parsed > MAX_PHRASE_FONT_SIZE_PT:
        return MAX_PHRASE_FONT_SIZE_PT
    return parsed


def _wrap_phrase(text: str, *, font: ImageFont.ImageFont, max_width: int) -> str:
    """Wrap phrase text to fit within ``max_width`` pixels."""

    if not text:
        return ""
    metrics_char = font.getlength("M") if hasattr(font, "getlength") else font.getbbox("M")[2]
    char_width = max(1, int(metrics_char))
    max_chars = max(1, max_width // char_width)
    lines: List[str] = []
    for paragraph in text.splitlines() or [""]:
        if not paragraph:
            lines.append("")
            continue
        for chunk in wrap(paragraph, width=max_chars):
            lines.append(chunk)
    return "\n".join(lines).strip("\n")


def _phrase_box(
    draw: ImageDraw.ImageDraw,
    text: str,
    *,
    font: ImageFont.ImageFont,
    canvas_width: int,
    margin: int,
    alignment: str = "left",
) -> Tuple[int, int, str, int]:
    """Return ``(left, top, wrapped_text, height)`` for the caption block."""

    if not text:
        return margin, margin, "", 0
    wrapped = _wrap_phrase(text, font=font, max_width=canvas_width - 2 * margin)
    if not wrapped:
        return margin, margin, "", 0
    bbox = draw.multiline_textbbox((margin, margin), wrapped, font=font, align=alignment)
    height = bbox[3] - bbox[1]
    width = bbox[2] - bbox[0]
    if alignment == "right":
        text_left = canvas_width - margin - width
    elif alignment == "center":
        text_left = margin + max(0, (canvas_width - 2 * margin - width) // 2)
    else:
        text_left = margin
    return text_left, margin, wrapped, height


def _resize_contain(img: Image.Image, available: Tuple[int, int]) -> Image.Image:
    """Return a resized copy that keeps the whole image visible."""

    img_ratio = img.width / max(img.height, 1)
    canvas_ratio = available[0] / max(available[1], 1)
    if img_ratio > canvas_ratio:
        new_width = available[0]
        new_height = int(max(1, new_width / max(img_ratio, 1e-6)))
    else:
        new_height = available[1]
        new_width = int(max(1, new_height * img_ratio))
    return img.resize((max(1, new_width), max(1, new_height)), RESAMPLE)


def _resize_cover(img: Image.Image, available: Tuple[int, int]) -> Image.Image:
    """Return a cropped copy that fully covers the available rectangle."""

    target_size = (max(1, available[0]), max(1, available[1]))
    return ImageOps.fit(img, target_size, method=RESAMPLE, centering=(0.5, 0.5))


def images_to_pdf(
    paths: Iterable[Path],
    output: Path,
    *,
    paper_size: str = "A4",
    orientation: str = "portrait",
    fit: str = "contain",
    margin_mm: int = 10,
    phrases: Mapping[int, str] | None = None,
    phrase_alignment: str = "left",
    phrase_font_size_pt: float | int | None = DEFAULT_PHRASE_FONT_SIZE_PT,
    page_numbers: bool = False,
) -> Path:
    """Create a PDF composed from image ``paths`` stored at ``output``."""

    size_map = {
        "A4": (595, 842),
        "Letter": (612, 792),
    }
    width, height = size_map.get(paper_size, size_map["A4"])
    if orientation == "landscape":
        width, height = height, width
    dpi = 300
    scale = dpi / 72
    margin = int(round(margin_mm * dpi / 25.4))
    canvas_size = (int(round(width * scale)), int(round(height * scale)))
    phrase_map: Dict[int, str] = {int(key): value for key, value in (phrases or {}).items() if value}
    phrase_size_pt = _normalize_phrase_font_size_pt(phrase_font_size_pt)
    font_size = max(10, int(round(phrase_size_pt * dpi / 72.0)))
    footer_font_size = max(10, int(round(14 * scale)))
    font = _load_font(font_size)
    footer_font = _load_font(footer_font_size)
    alignment = phrase_alignment if phrase_alignment in {"left", "center", "right"} else "left"

    source_paths = [Path(p) for p in paths]

    pdf_images: List[Image.Image] = []
    try:
        total_pages = len(source_paths)
        for index, path in enumerate(source_paths):
            img = Image.open(path).convert("RGB")
            page = Image.new("RGB", canvas_size, "white")
            draw = ImageDraw.Draw(page)
            phrase = phrase_map.get(index)
            text_left, text_top, wrapped, text_height = _phrase_box(
                draw,
                phrase or "",
                font=font,
                canvas_width=canvas_size[0],
                margin=margin,
                alignment=alignment,
            )
            image_top = text_top
            if wrapped:
                draw.multiline_text((text_left, text_top), wrapped, font=font, fill="black", align=alignment)
                image_top = text_top + text_height + margin
            available_height = max(1, canvas_size[1] - image_top - margin)
            available = (canvas_size[0] - 2 * margin, available_height)
            if available[0] <= 0 or available[1] <= 0:
                resized = _resize_contain(img, (1, 1))
                offset_x = margin
                offset_y = image_top
            else:
                if fit == "cover":
                    resized = _resize_cover(img, available)
                    offset_x = margin
                    offset_y = image_top
                else:
                    resized = _resize_contain(img, available)
                    offset_x = margin + max(0, (available[0] - resized.width) // 2)
                    offset_y = image_top + max(0, (available[1] - resized.height) // 2)
            page.paste(resized, (offset_x, offset_y))
            if page_numbers:
                footer = f"{index + 1}/{total_pages}" if total_pages else str(index + 1)
                bbox = draw.textbbox((0, 0), footer, font=footer_font)
                footer_width = bbox[2] - bbox[0]
                footer_height = bbox[3] - bbox[1]
                footer_x = canvas_size[0] - margin - footer_width
                footer_y = canvas_size[1] - margin - footer_height
                draw.text((footer_x, footer_y), footer, font=footer_font, fill="black")
            pdf_images.append(page)
            img.close()
        if not pdf_images:
            raise MergeError("No images provided")
        pdf_images[0].save(
            output,
            save_all=True,
            append_images=pdf_images[1:],
            format="PDF",
            resolution=dpi,
        )
    finally:
        for img in pdf_images:
            img.close()
    return output


def _escape_pdf_text(value: str) -> str:
    """Escape parentheses and backslashes for PDF content streams."""

    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _apply_pdf_page_numbers(writer: PdfWriter, *, margin: float = 36.0, block_height: float = 24.0) -> None:
    """Overlay sequential page numbers across the merged document."""

    total_pages = len(writer.pages)
    if total_pages == 0:
        return
    font_ref = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    font_name = NameObject("/QFPF")
    for index, page in enumerate(writer.pages):
        page_object = page.get_object()
        width = float(page_object.mediabox.width)
        label = f"{index + 1}/{total_pages}"
        escaped = _escape_pdf_text(label)
        approx_text_width = max(20.0, 0.6 * 12 * len(label))
        text_x = max(margin, width - margin - approx_text_width)
        text_y = max(8.0, margin * 0.6)
        rect_height = max(block_height + margin, margin + 20.0)
        rect_y = 0.0
        stream = DecodedStreamObject()
        stream.set_data(
            (
                "q\n"
                "1 1 1 rg\n"
                f"0 {rect_y} {width:.2f} {rect_height:.2f} re f\n"
                "Q\n"
                "BT\n"
                f"{font_name} 12 Tf\n"
                "0 0 0 rg\n"
                f"1 0 0 1 {text_x:.2f} {text_y:.2f} Tm\n"
                f"({escaped}) Tj\n"
                "ET\n"
            ).encode("utf-8")
        )
        stream_ref = writer._add_object(stream)
        contents = page_object.get(NameObject("/Contents"))
        if contents is None:
            page_object[NameObject("/Contents")] = ArrayObject([stream_ref])
        elif isinstance(contents, ArrayObject):
            contents.append(stream_ref)
        else:
            page_object[NameObject("/Contents")] = ArrayObject([contents, stream_ref])
        resources = page_object.setdefault(NameObject("/Resources"), DictionaryObject())
        fonts = resources.setdefault(NameObject("/Font"), DictionaryObject())
        if font_name not in fonts:
            fonts[font_name] = font_ref
