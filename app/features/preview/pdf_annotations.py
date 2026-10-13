"""Editable PDF annotation pages with vector appearance and recoverable saves."""

from __future__ import annotations

import copy
import io
import json
import math
import re
from pathlib import Path
from uuid import uuid4

from PIL import ImageColor
from pypdf import PdfReader, PdfWriter
from pypdf._codecs.core_font_metrics import CORE_FONT_METRICS
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject,
    FloatObject, NameObject, NumberObject, TextStringObject,
)

from .image_history import ImageHistory, IMAGE_LOCK, MAX_BYTES, digest, validate_document
from ..filesystem.service import resolve_within_root


def _number(value):
    value = float(value)
    if not math.isfinite(value) or abs(value) > 10_000_000:
        raise ValueError("Invalid PDF annotation coordinate.")
    return format(value, '.8f').rstrip('0').rstrip('.') or '0'


def page_geometry(page):
    media, crop = page.mediabox, page.cropbox
    x0, y0 = max(float(media.left), float(crop.left)), max(float(media.bottom), float(crop.bottom))
    x1, y1 = min(float(media.right), float(crop.right)), min(float(media.top), float(crop.top))
    unit = float(page.get('/UserUnit', 1))
    rotation = int(page.rotation) % 360
    values = (x0, y0, x1, y1, unit)
    if not all(math.isfinite(value) for value in values) or unit <= 0 or x1 <= x0 or y1 <= y0 or rotation not in (0, 90, 180, 270):
        raise ValueError("This PDF has unsupported page geometry.")
    width, height = (x1 - x0) * unit, (y1 - y0) * unit
    if rotation in (90, 270):
        width, height = height, width
    if max(width, height) > 100_000:
        raise ValueError("This PDF page is too large to annotate safely.")
    matrices = {
        0: (1, 0, 0, -1, x0, y1),
        90: (0, 1, 1, 0, x0, y0),
        180: (-1, 0, 0, 1, x1, y0),
        270: (0, -1, -1, 0, x1, y1),
    }
    matrix = matrices[rotation]
    return width, height, (x0, y0, x1, y1), (*[v / unit for v in matrix[:4]], *matrix[4:])


def _reader(binary):
    reader = PdfReader(io.BytesIO(binary))
    if reader.is_encrypted:
        raise ValueError("Save an unprotected copy of this PDF before annotating it.")
    if not reader.pages:
        raise ValueError("The PDF has no pages.")
    if reader.trailer['/Root'].get('/Perms'):
        raise ValueError("Save an unsigned copy of this PDF before annotating it.")
    fields = reader.get_fields() or {}
    if any(field.get('/FT') == '/Sig' and field.get('/V') for field in fields.values()):
        raise ValueError("Save an unsigned copy of this PDF before annotating it.")
    return reader


def blank_document(reader):
    pages = []
    for page in reader.pages:
        width, height, _, _ = page_geometry(page)
        pages.append({'version': 1, 'width': width, 'height': height, 'nodes': []})
    return {'version': 1, 'kind': 'pdf', 'width': pages[0]['width'], 'height': pages[0]['height'], 'pages': pages}


def validate_pdf_document(document, reader):
    if not isinstance(document, dict) or set(document) != {'version', 'kind', 'width', 'height', 'pages'} or document.get('version') != 1 or document.get('kind') != 'pdf':
        raise ValueError("Invalid PDF annotation document.")
    pages = document.get('pages')
    if not isinstance(pages, list) or len(pages) != len(reader.pages):
        raise ValueError("PDF annotation pages do not match the document.")
    if len(json.dumps(document)) > 16_000_000:
        raise ValueError("PDF annotations are too large to save safely.")
    for saved, page in zip(pages, reader.pages):
        width, height, _, _ = page_geometry(page)
        validate_document(saved, (width, height))
        for node in saved['nodes']:
            _validate_pdf_node(node)
    if (document['width'], document['height']) != (pages[0]['width'], pages[0]['height']):
        raise ValueError("PDF annotation dimensions do not match the document.")


def _validate_pdf_node(node):
    numeric = {'x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'skewX', 'skewY', 'offsetX', 'offsetY', 'opacity', 'strokeWidth', 'radius', 'radiusX', 'radiusY', 'fontSize', 'pointerLength', 'pointerWidth'}
    attrs = node.get('attrs', {})
    for name in numeric.intersection(attrs):
        value = attrs[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("PDF annotation coordinates must be numeric.")
        _number(value)
    for name in ('points', 'dash'):
        if name in attrs and (not isinstance(attrs[name], list) or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in attrs[name])):
            raise ValueError("PDF annotation paths must be numeric.")
    for child in node.get('children', []):
        _validate_pdf_node(child)


def _color(value):
    value = str(value)
    rgba = re.fullmatch(r'rgba\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)', value)
    if rgba:
        r, g, b, alpha = map(float, rgba.groups())
        if not all(0 <= channel <= 255 for channel in (r, g, b)) or not 0 <= alpha <= 1:
            raise ValueError("Invalid annotation color.")
        return (r / 255, g / 255, b / 255), alpha
    try:
        r, g, b, a = ImageColor.getcolor(value, 'RGBA')
        return (r / 255, g / 255, b / 255), a / 255
    except ValueError as exc:
        raise ValueError("Invalid annotation color.") from exc


class _Appearance:
    def __init__(self, writer):
        self.writer = writer
        self.ops = []
        self.resources = DictionaryObject()
        self.alphas = {}
        self.states = DictionaryObject()
        self.resources[NameObject('/ExtGState')] = self.states
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica-Bold'), NameObject('/Encoding'): NameObject('/WinAnsiEncoding')})
        self.resources[NameObject('/Font')] = DictionaryObject({NameObject('/QFNumber'): writer._add_object(font)})

    def command(self, *values):
        self.ops.append(' '.join(_number(v) if isinstance(v, (float, int)) else str(v) for v in values))

    def paint_state(self, attrs, opacity):
        fill, stroke = attrs.get('fill'), attrs.get('stroke')
        fa, sa = opacity, opacity
        if fill:
            rgb, alpha = _color(fill)
            self.command(*rgb, 'rg')
            fa *= alpha
        if stroke:
            rgb, alpha = _color(stroke)
            self.command(*rgb, 'RG')
            sa *= alpha
        key = (round(fa, 8), round(sa, 8))
        if key not in self.alphas:
            name = f'/QFA{len(self.alphas)}'
            self.alphas[key] = name
            self.states[NameObject(name)] = self.writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/ExtGState'), NameObject('/ca'): FloatObject(fa), NameObject('/CA'): FloatObject(sa)}))
        self.command(self.alphas[key], 'gs')
        width = max(0, float(attrs.get('strokeWidth', 2)))
        self.command(width, 'w')
        self.command({'butt': 0, 'round': 1, 'square': 2}.get(attrs.get('lineCap'), 0), 'J')
        self.command({'miter': 0, 'round': 1, 'bevel': 2}.get(attrs.get('lineJoin'), 0), 'j')
        dash = attrs.get('dash', [])
        if dash and attrs.get('dashEnabled', True):
            self.command('[' + ' '.join(_number(max(0, float(v))) for v in dash) + ']', 0, 'd')
        fill_on = bool(fill) and attrs.get('fillEnabled', True)
        stroke_on = bool(stroke) and width > 0 and attrs.get('strokeEnabled', True)
        return 'B' if fill_on and stroke_on else 'f' if fill_on else 'S' if stroke_on else 'n'

    def node(self, node, inherited_opacity=1):
        attrs = node.get('attrs', {})
        if attrs.get('visible') is False:
            return
        opacity = inherited_opacity * min(1, max(0, float(attrs.get('opacity', 1))))
        self.command('q')
        self.command(1, 0, 0, 1, attrs.get('x', 0), attrs.get('y', 0), 'cm')
        angle = math.radians(float(attrs.get('rotation', 0)))
        self.command(math.cos(angle), math.sin(angle), -math.sin(angle), math.cos(angle), 0, 0, 'cm')
        self.command(1, attrs.get('skewY', 0), attrs.get('skewX', 0), 1, 0, 0, 'cm')
        self.command(attrs.get('scaleX', 1), 0, 0, attrs.get('scaleY', 1), 0, 0, 'cm')
        self.command(1, 0, 0, 1, -float(attrs.get('offsetX', 0)), -float(attrs.get('offsetY', 0)), 'cm')
        kind = node['className']
        paint = self.paint_state(attrs, opacity)
        if kind == 'Group':
            for child in node.get('children', []):
                self.node(child, opacity)
        elif kind == 'Rect':
            self.command(0, 0, attrs.get('width', 0), attrs.get('height', 0), 're', paint)
        elif kind in {'Circle', 'Ellipse'}:
            rx, ry = (float(attrs.get('radius', 0)),) * 2 if kind == 'Circle' else (float(attrs.get('radiusX', 0)), float(attrs.get('radiusY', 0)))
            k = 0.5522847498307936
            self.command(rx, 0, 'm')
            self.command(rx, k * ry, k * rx, ry, 0, ry, 'c')
            self.command(-k * rx, ry, -rx, k * ry, -rx, 0, 'c')
            self.command(-rx, -k * ry, -k * rx, -ry, 0, -ry, 'c')
            self.command(k * rx, -ry, rx, -k * ry, rx, 0, 'c', 'h', paint)
        elif kind in {'Line', 'Arrow'}:
            points = attrs.get('points', [])
            if len(points) < 4 or len(points) % 2:
                raise ValueError("Invalid annotation line.")
            self.command(*points[:2], 'm')
            for index in range(2, len(points), 2):
                self.command(*points[index:index + 2], 'l')
            if attrs.get('closed'):
                self.command('h')
            self.command(paint)
            if kind == 'Arrow':
                self.arrow(points[-4:], attrs, paint)
                if attrs.get('pointerAtBeginning'):
                    self.arrow([*points[2:4], *points[:2]], attrs, paint)
        elif kind == 'Text':
            text = str(attrs.get('text', ''))
            try:
                encoded = text.encode('cp1252').hex()
            except UnicodeEncodeError as exc:
                raise ValueError("This annotation text needs a supported PDF font.") from exc
            size = max(1, float(attrs.get('fontSize', 12)))
            self.command('BT', '/QFNumber', size, 'Tf', 1, 0, 0, -1, 0, size * 0.8, 'Tm', f'<{encoded}>', 'Tj', 'ET')
        self.command('Q')

    def arrow(self, points, attrs, paint):
        x0, y0, x, y = map(float, points)
        angle = math.atan2(y - y0, x - x0)
        length, half = float(attrs.get('pointerLength', 10)), float(attrs.get('pointerWidth', 10)) / 2
        bx, by = x - math.cos(angle) * length, y - math.sin(angle) * length
        self.command(x, y, 'm', bx - math.sin(angle) * half, by + math.cos(angle) * half, 'l', bx + math.sin(angle) * half, by - math.cos(angle) * half, 'l', 'h', paint)


def _multiply(left, right):
    """Compose the same affine transforms used by the vector appearance."""
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return (a*g + c*h, b*g + d*h, a*i + c*j, b*i + d*j,
            a*k + c*l + e, b*k + d*l + f)


def _node_matrix(attrs, parent):
    angle = math.radians(float(attrs.get('rotation', 0)))
    transforms = (
        (1, 0, 0, 1, attrs.get('x', 0), attrs.get('y', 0)),
        (math.cos(angle), math.sin(angle), -math.sin(angle), math.cos(angle), 0, 0),
        (1, attrs.get('skewY', 0), attrs.get('skewX', 0), 1, 0, 0),
        (attrs.get('scaleX', 1), 0, 0, attrs.get('scaleY', 1), 0, 0),
        (1, 0, 0, 1, -float(attrs.get('offsetX', 0)), -float(attrs.get('offsetY', 0))),
    )
    for transform in transforms:
        parent = _multiply(parent, transform)
    return parent


def _union_bounds(boxes):
    boxes = [box for box in boxes if box is not None]
    if not boxes:
        return None
    return (min(box[0] for box in boxes), min(box[1] for box in boxes),
            max(box[2] for box in boxes), max(box[3] for box in boxes))


def _transformed_bounds(points, matrix):
    a, b, c, d, e, f = matrix
    transformed = [(a*x + c*y + e, b*x + d*y + f) for x, y in points]
    return (min(p[0] for p in transformed), min(p[1] for p in transformed),
            max(p[0] for p in transformed), max(p[1] for p in transformed))


def _ellipse_bounds(rx, ry, matrix):
    """Include the extrema of the actual four cubic curves, after transformation."""
    a, b, c, d, e, f = matrix
    k = 0.5522847498307936
    curves = (
        ((rx, 0), (rx, k*ry), (k*rx, ry), (0, ry)),
        ((0, ry), (-k*rx, ry), (-rx, k*ry), (-rx, 0)),
        ((-rx, 0), (-rx, -k*ry), (-k*rx, -ry), (0, -ry)),
        ((0, -ry), (k*rx, -ry), (rx, -k*ry), (rx, 0)),
    )
    points = []
    for curve in curves:
        mapped = [(a*x+c*y+e, b*x+d*y+f) for x, y in curve]
        points.extend((mapped[0], mapped[-1]))
        for axis in (0, 1):
            p0, p1, p2, p3 = [point[axis] for point in mapped]
            qa, qb, qc = p3-3*p2+3*p1-p0, 2*(p2-2*p1+p0), p1-p0
            roots = []
            if abs(qa) < 1e-12:
                if abs(qb) >= 1e-12:
                    roots.append(-qc/qb)
            else:
                discriminant = qb*qb-4*qa*qc
                if discriminant >= 0:
                    roots.extend(((-qb+math.sqrt(discriminant))/(2*qa),
                                  (-qb-math.sqrt(discriminant))/(2*qa)))
            for t in roots:
                if 0 < t < 1:
                    points.append(tuple((1-t)**3*mapped[0][i] + 3*(1-t)**2*t*mapped[1][i]
                                        + 3*(1-t)*t*t*mapped[2][i] + t**3*mapped[3][i]
                                        for i in (0, 1)))
    return _transformed_bounds(points, (1, 0, 0, 1, 0, 0))


def _node_bounds(node, parent):
    """Bound one logical object, including its children and stroked edges."""
    attrs, kind = node.get('attrs', {}), node['className']
    if attrs.get('visible') is False:
        return None
    matrix = _node_matrix(attrs, parent)
    if kind == 'Group':
        return _union_bounds(_node_bounds(child, matrix) for child in node.get('children', []))
    stroke = (max(0, float(attrs.get('strokeWidth', 2))) / 2
              if attrs.get('stroke') and attrs.get('strokeEnabled', True) else 0)
    if kind in {'Circle', 'Ellipse'}:
        rx, ry = ((abs(float(attrs.get('radius', 0))),) * 2 if kind == 'Circle'
                  else (abs(float(attrs.get('radiusX', 0))), abs(float(attrs.get('radiusY', 0)))))
        a, b, c, d, _, _ = matrix
        x0, y0, x1, y1 = _ellipse_bounds(rx, ry, matrix)
        dx, dy = stroke*math.hypot(a, c), stroke*math.hypot(b, d)
        return x0-dx, y0-dy, x1+dx, y1+dy
    if kind == 'Rect':
        x0, x1 = sorted((0, float(attrs.get('width', 0))))
        y0, y1 = sorted((0, float(attrs.get('height', 0))))
    elif kind == 'Text':
        text = str(attrs.get('text', ''))
        size = max(1, float(attrs.get('fontSize', 12)))
        metrics = CORE_FONT_METRICS['Helvetica-Bold']
        advances = [metrics.character_widths.get(char, metrics.character_widths['default']) for char in text]
        # Use the pinned PDF font's full glyph bounds to retain accents and descenders.
        left, bottom, right, top = metrics.font_descriptor.bbox
        x0, x1 = left*size/1000, (sum(advances[:-1]) + right)*size/1000
        y0, y1 = (0.8-top/1000)*size, (0.8-bottom/1000)*size
        stroke = 0
    else:
        values = attrs.get('points', [])
        if len(values) < 4 or len(values) % 2:
            raise ValueError('Invalid annotation line.')
        points = list(zip(values[::2], values[1::2]))
        if kind == 'Arrow':
            ends = [(points[-2], points[-1])]
            if attrs.get('pointerAtBeginning'):
                ends.append((points[1], points[0]))
            for (x0, y0), (x, y) in ends:
                angle = math.atan2(y-y0, x-x0)
                length, half = float(attrs.get('pointerLength', 10)), float(attrs.get('pointerWidth', 10))/2
                bx, by = x-math.cos(angle)*length, y-math.sin(angle)*length
                points.extend(((bx-math.sin(angle)*half, by+math.cos(angle)*half),
                               (bx+math.sin(angle)*half, by-math.cos(angle)*half)))
        # PDF's default miter limit is 10. Acute path corners can extend farther
        # than half the stroke, while an ordinary two-point line cannot.
        if (kind == 'Arrow' or len(points) > 2) and attrs.get('lineJoin', 'miter') == 'miter':
            stroke *= 10
        x0, y0, x1, y1 = _transformed_bounds(points, (1, 0, 0, 1, 0, 0))
    return _transformed_bounds(((x0-stroke, y0-stroke), (x1+stroke, y0-stroke),
                                (x1+stroke, y1+stroke), (x0-stroke, y1+stroke)), matrix)


def _annotation_label(node):
    kind = node['className']
    if kind == 'Group':
        labels = [str(child.get('attrs', {}).get('text', ''))
                  for child in node.get('children', []) if child['className'] == 'Text']
        return 'Number ' + ' '.join(labels) if labels else 'Annotation group'
    return {'Rect': 'Rectangle', 'Ellipse': 'Ellipse', 'Circle': 'Circle',
            'Line': 'Line', 'Arrow': 'Arrow', 'Text': 'Text'}.get(kind, 'Annotation')


def render_pdf(binary, document):
    reader = _reader(binary)
    validate_pdf_document(document, reader)
    writer = PdfWriter(clone_from=reader)
    for page, saved in zip(writer.pages, document['pages']):
        if not saved['nodes']:
            continue
        _, _, _, matrix = page_geometry(page)
        annotations = page.get('/Annots')
        annotations = annotations.get_object() if annotations is not None else ArrayObject()
        for node in saved['nodes']:
            box = _node_bounds(node, matrix)
            if box is None:
                continue
            # A small numerical margin prevents antialiased edges from clipping.
            box = (box[0]-0.01, box[1]-0.01, box[2]+0.01, box[3]+0.01)
            if not all(math.isfinite(value) and abs(value) <= 10_000_000 for value in box):
                raise ValueError('Annotation bounds are too large to save safely.')
            drawing = _Appearance(writer)
            drawing.command('q', *matrix, 'cm')
            drawing.node(node)
            drawing.command('Q')
            appearance = DecodedStreamObject()
            appearance.set_data(('\n'.join(drawing.ops) + '\n').encode('ascii'))
            appearance.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'), NameObject('/FormType'): NumberObject(1), NameObject('/BBox'): ArrayObject([FloatObject(v) for v in box]), NameObject('/Resources'): drawing.resources})
            stamp = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Stamp'), NameObject('/Rect'): ArrayObject([FloatObject(v) for v in box]), NameObject('/F'): NumberObject(4), NameObject('/NM'): TextStringObject('QualiFile-' + uuid4().hex), NameObject('/T'): TextStringObject('QualiFile'), NameObject('/Contents'): TextStringObject(_annotation_label(node)), NameObject('/AP'): DictionaryObject({NameObject('/N'): writer._add_object(appearance.flate_encode())})})
            annotations.append(writer._add_object(stamp))
        page[NameObject('/Annots')] = annotations
    output = io.BytesIO()
    writer.write(output)
    writer.close()
    return output.getvalue()


class PdfHistory(ImageHistory):
    """Use the existing document identity, immutable blobs and recovery journal."""

    def target(self, relative):
        target = resolve_within_root(self.root, relative)
        if target.suffix.lower() != '.pdf' or not target.is_file():
            raise ValueError("Select a PDF file.")
        if target.stat().st_size > MAX_BYTES:
            raise ValueError("This PDF is too large for the annotation editor.")
        return target

    def document(self, relative):
        target = self.target(relative)
        relative = target.relative_to(self.root).as_posix()
        binary = target.read_bytes()
        current_hash = digest(binary)
        row = self.conn.execute('SELECT file_id,state_json FROM image_documents WHERE root_id=? AND path=?', (self.root_id, relative)).fetchone()
        file_id, state = (row[0], json.loads(row[1])) if row else (uuid4().hex, {})
        pending = self.conn.execute('SELECT before_json,after_json FROM image_pending_writes WHERE file_id=?', (file_id,)).fetchone()
        if pending:
            before, after = map(json.loads, pending)
            state = after if current_hash == after['hash'] else before if current_hash == before['hash'] else None
            if state is None:
                raise ValueError("An interrupted PDF save needs recovery before further edits.")
            with self.conn:
                self._put_state(file_id, state)
                self.conn.execute('DELETE FROM image_pending_writes WHERE file_id=?', (file_id,))
        if state.get('hash') != current_hash:
            reader = _reader(binary)
            state = {'hash': current_hash, 'base': self._blob(binary), 'overlay': None, 'document': blank_document(reader)}
            with self.conn:
                self.conn.execute('INSERT INTO image_documents VALUES(?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET state_json=excluded.state_json', (file_id, self.root_id, relative, json.dumps(state)))
        if state.get('document', {}).get('kind') != 'pdf':
            raise ValueError("Invalid saved PDF annotation state.")
        return file_id, state

    def save_pdf(self, relative, document, expected_hash, *, destination=None):
        with IMAGE_LOCK:
            file_id, before = self.document(relative)
            if expected_hash != before['hash']:
                raise ValueError("PDF changed since it was opened. Reload it before saving.")
            if destination is not None and Path(destination).suffix.lower() != '.pdf':
                raise ValueError("The annotated copy must have a .pdf extension.")
            base = self._read_blob(before['base'])
            _reader(self.target(relative).read_bytes())
            binary = render_pdf(base, document)
            if len(binary) > MAX_BYTES:
                raise ValueError("The annotated PDF exceeds the editor's safe save size.")
            after = {'hash': digest(binary), 'base': before['base'], 'overlay': None, 'document': copy.deepcopy(document)}
            self._save_state(relative, binary, file_id, before, after, destination=destination, reason='PDF annotation save')
            return after

    def restore(self, relative, version_id, expected_hash):
        with IMAGE_LOCK:
            binary, restored = self.version(relative, version_id)
            file_id, before = self.document(relative)
            if expected_hash != before['hash']:
                raise ValueError("PDF changed since it was opened. Reload it before restoring.")
            restored['base'] = self._blob(self._read_blob(restored['base']))
            self._save_state(relative, binary, file_id, before, restored, reason='Restored previous PDF version')
