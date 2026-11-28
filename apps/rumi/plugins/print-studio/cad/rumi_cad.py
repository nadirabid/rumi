"""build123d B-Rep CAD publishing, STEP/BREP I/O, revision restore, and control recipe helpers.

Work in millimetres with Z up. Publishes self-contained ASCII `#usda 1.0` previews alongside
exact B-Rep `.step` and per-part `.brep` originals in immutable revision directories.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable

import numpy as np

_HERE = Path(__file__).resolve().parent
_robot_usd = runpy.run_path(str(_HERE / 'robot_usd.py'))
_evidence = runpy.run_path(str(_HERE / 'recipe_evidence.py'))
_validator = runpy.run_path(str(_HERE / 'validate.py'))

write_robot_usd = _robot_usd['write_robot_usd']
read_robot = _robot_usd['read_robot']
validate_usda_text = _robot_usd['validate_usda_text']
require_separate_moving_parts = _robot_usd['require_separate_moving_parts']
make_valid_identifier = _robot_usd['make_valid_identifier']
published_features = _evidence['published_features']
weld_mesh = _validator['weld_mesh']
analyze_part_print_orientation = _validator['analyze_part_print_orientation']

CHECKS_TIMEOUT_SECONDS = 60
CHECKS_NOTE = 'Bullet mechanics were not run; call validation_mechanics when the design is ready.'
MAX_TRIANGLES = 200000
USD_MIN_BYTES = 10
USD_MAX_BYTES = 64 * 1024 * 1024
_DEFLECTION_STEPS = (0.05, 0.1, 0.2, 0.4, 0.8, 1.5)


def _unavailable(message: str) -> dict[str, Any]:
    return {'status': 'unavailable', 'message': str(message)[:400]}


def _unwrap_shape(shape: Any) -> Any:
    return shape.wrapped if hasattr(shape, 'wrapped') else shape


def _extract_color(shape: Any) -> tuple[float, float, float, float] | None:
    color = getattr(shape, 'color', None)
    if color is None:
        return None
    values = [float(c) for c in color]
    if len(values) == 3:
        values.append(1.0)
    if len(values) != 4 or not all(math.isfinite(c) for c in values):
        raise ValueError('Part color must have 3 or 4 finite RGB(A) channels')
    return tuple(max(0.0, min(1.0, c)) for c in values)  # type: ignore[return-value]


def _normalize_parts(parts: Any) -> list[tuple[str, str, Any]]:
    """Normalize input parts into [(raw_label, usd_id, shape), ...] with unique USD IDs."""
    items: list[tuple[str, Any]] = []
    if isinstance(parts, dict):
        items = [(str(k), v) for k, v in parts.items()]
    elif hasattr(parts, 'wrapped') or type(parts).__name__.startswith('TopoDS_'):
        label = getattr(parts, 'label', '') or 'Model'
        items = [(label, parts)]
    else:
        raw_list = list(parts)
        for idx, part in enumerate(raw_list):
            label = getattr(part, 'label', '')
            if not label:
                if len(raw_list) == 1:
                    label = 'Model'
                else:
                    raise ValueError(f'Part at index {idx} must have a non-empty .label')
            items.append((label, part))

    if not items:
        raise ValueError('No visible B-Rep parts to publish')

    result: list[tuple[str, str, Any]] = []
    seen_ids: set[str] = set()
    for raw_label, shape in items:
        if not (hasattr(shape, 'wrapped') or type(shape).__name__.startswith('TopoDS_')):
            raise TypeError(f'Part {raw_label!r} must be a build123d Shape/Part/Solid/Compound')
        usd_id = make_valid_identifier(raw_label)
        if usd_id in seen_ids:
            raise ValueError(f'Duplicate part identifier after USD sanitization: {usd_id}')
        seen_ids.add(usd_id)
        result.append((raw_label, usd_id, shape))
    return result


def tessellate_shape(
    shape: Any,
    deflection: float = 0.05,
    angular_deflection: float = 0.25,
) -> tuple[np.ndarray, np.ndarray]:
    """Tessellate a build123d/OCP shape in mm and weld vertices at 1e-5 mm."""
    import build123d as bd

    if isinstance(shape, bd.Shape):
        verts, tris = shape.tessellate(deflection, angular_deflection)
        pts = np.array([(v.X, v.Y, v.Z) for v in verts], dtype=np.float64)
        tri_arr = np.asarray(tris, dtype=np.int64)
    else:
        wrapped = bd.Shape(shape)
        verts, tris = wrapped.tessellate(deflection, angular_deflection)
        pts = np.array([(v.X, v.Y, v.Z) for v in verts], dtype=np.float64)
        tri_arr = np.asarray(tris, dtype=np.int64)

    if len(pts) == 0 or len(tri_arr) == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int64)
    if not np.isfinite(pts).all():
        raise ValueError('Nonfinite coordinates in tessellated B-Rep shape')
    return weld_mesh(pts, tri_arr, dist=1e-5)


def _tessellate_all(
    normalized_parts: list[tuple[str, str, Any]],
) -> tuple[list[dict[str, Any]], int, np.ndarray]:
    """Tessellate all parts with adaptive deflection to stay within 1..200,000 triangles."""
    last_total = 0
    for deflection in _DEFLECTION_STEPS:
        angular = min(0.5, 0.2 + deflection * 0.4)
        meshes: list[dict[str, Any]] = []
        total_tris = 0
        all_pts_list: list[np.ndarray] = []
        for raw_label, usd_id, shape in normalized_parts:
            pts_mm, tris = tessellate_shape(shape, deflection=deflection, angular_deflection=angular)
            if len(tris) == 0:
                raise ValueError(f'Part {raw_label!r} produced empty geometry')
            total_tris += len(tris)
            all_pts_list.append(pts_mm)
            meshes.append({
                'name': usd_id,
                'raw_label': raw_label,
                'points_mm': pts_mm,
                'points': pts_mm * 0.001,  # USD uses metres, Z-up
                'triangles': tris,
                'color': _extract_color(shape),
            })
        last_total = total_tris
        if 0 < total_tris <= MAX_TRIANGLES:
            return meshes, total_tris, np.vstack(all_pts_list)

    raise ValueError(
        f'Preview requires 1–{MAX_TRIANGLES:,} triangles (got {last_total:,}); preserve detailed originals'
    )


def _export_brep_file(shape: Any, path: Path) -> None:
    """Write a lossless OpenCASCADE .brep file."""
    from OCP.BRepTools import BRepTools

    wrapped = _unwrap_shape(shape)
    if not BRepTools.Write_s(wrapped, str(path)):
        raise RuntimeError(f'Failed to export B-Rep to {path}')


def _export_step_file(normalized_parts: list[tuple[str, str, Any]], path: Path) -> None:
    """Export an exact B-Rep STEP assembly preserving part labels and colors."""
    import build123d as bd

    children = []
    for raw_label, usd_id, shape in normalized_parts:
        s = shape if isinstance(shape, bd.Shape) else bd.Shape(shape)
        s_copy = bd.Shape(s.wrapped)
        s_copy.label = usd_id
        color = _extract_color(shape)
        if color is not None:
            s_copy.color = bd.Color(*color)
        children.append(s_copy)
    compound = bd.Compound(label='Model', children=children)
    bd.export_step(compound, str(path))


def _publish_preview(directory: Path, data: bytes) -> dict[str, Any]:
    """Atomically replace the visible preview and return its content hash and file stat identity."""
    target = directory / 'model.usda'
    temporary = directory / ('.preview-' + uuid.uuid4().hex + '.usda')
    try:
        temporary.write_bytes(data)
        before = temporary.stat()
        os.replace(temporary, target)
        after = target.stat()
    finally:
        temporary.unlink(missing_ok=True)
    result: dict[str, Any] = {'sourceHash': hashlib.sha256(data).hexdigest()}
    if os.path.samestat(before, after) and (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns):
        result['savedFileStat'] = ':'.join(str(value) for value in (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ))
    return result


def run_checks(usd: Path | str, model_directory: Path | str) -> dict[str, Any]:
    """Validate a published revision in a clean Python subprocess and return a bounded summary.

    Settings come from the nearest ancestor `.rumi/print-checks.json`, written by `cad_status`.
    Every infrastructure failure, including a timeout, yields status "unavailable".
    """
    resolved_dir = Path(model_directory).resolve()
    project = next(
        (parent for parent in (resolved_dir, *resolved_dir.parents)
         if (parent / '.rumi' / 'print-checks.json').is_file()),
        None,
    )
    if project is None:
        return _unavailable('Call cad_status in this project, then publish again.')
    scratch: Path | None = None
    try:
        settings = json.loads((project / '.rumi' / 'print-checks.json').read_text(encoding='utf-8'))['settings']
        (project / '.rumi' / 'tmp').mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix='check-', dir=project / '.rumi' / 'tmp'))
        output = scratch / 'result.json'
        request = scratch / 'request.json'
        request.write_text(json.dumps({
            'input': str(usd),
            'output': str(output),
            'mechanicsOutput': str(scratch / 'mechanics.json'),
            'stage': 'all',
            'volume': None,
            'settings': settings,
            'transform': {
                'scale': 1,
                'rotate': {'x': 0, 'y': 0, 'z': 0},
                'position': {'x': 0, 'y': 0, 'z': 0},
            },
        }), encoding='utf-8')
        environment = {key: value for key, value in os.environ.items() if not key.startswith('PYTHON')}
        if 'PYTHONHOME' in os.environ:
            environment['PYTHONHOME'] = os.environ['PYTHONHOME']
        elif sys.prefix == sys.base_prefix:
            environment['PYTHONHOME'] = sys.prefix
        environment['PYTHONDONTWRITEBYTECODE'] = '1'
        environment['PYTHONNOUSERSITE'] = '1'
        completed = subprocess.run(
            [sys.executable, '-s', '-B', str(_HERE / 'validate.py'), str(request)],
            capture_output=True,
            text=True,
            timeout=CHECKS_TIMEOUT_SECONDS,
            env=environment,
            cwd=scratch,
        )
        if completed.returncode != 0:
            return _unavailable('Check process failed: ' + (completed.stdout + completed.stderr)[-300:])
        result = json.loads(output.read_text(encoding='utf-8'))
        summary: dict[str, Any] = {
            'status': 'needs_repair' if result.get('robotError') else result['status'],
            'checks': [
                {key: item[key] for key in ('code', 'count', 'severity', 'details') if key in item}
                for item in result['checks'] if item['count']
            ],
            'dimensionsMm': {axis: round(result['dimensions'][axis], 2) for axis in 'xyz'},
            'note': CHECKS_NOTE,
        }
        if result.get('printOrientations'):
            summary['printOrientations'] = result['printOrientations']
        if result.get('robotError'):
            summary['assemblyError'] = str(result['robotError'])[:400]
        return summary
    except subprocess.TimeoutExpired:
        return _unavailable(f'Checks exceeded {CHECKS_TIMEOUT_SECONDS} seconds.')
    except Exception as error:
        return _unavailable(f'{type(error).__name__}: {error}')
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)


def publish(
    model_directory: str | Path,
    parts: Any,
    configure_assembly: Callable[[dict[str, Any]], Any] | None = None,
    assembly: dict[str, Any] | None = None,
    check: bool = True,
    features: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Atomically publish self-contained model.usda plus exact STEP and lossless B-Rep originals.

    Args:
        model_directory: Target `models/<name>` directory.
        parts: build123d Shape/Part/Solid/Compound, sequence of parts (with `.label` and optional `.color`),
            or dict `{name: shape}` in millimetres, Z-up.
        configure_assembly: Optional callback `configure_assembly(doc)` that mutates `doc['assembly']`
            and/or `doc['controls']` before serialization.
        assembly: Optional version-1 assembly dict (root, parts, connections, sequences, manufacturing,
            optional controls).
        check: When True, runs `cad/validate.py` in a clean subprocess and prints `RUMI_CHECKS <json>`.
        features: Optional extra badge evidence records from `recipe_evidence.make_feature`.

    Returns:
        Publication receipt dict matching `RUMI_MODEL <json>` (plus `'checks'` when `check=True`).
    """
    directory = Path(model_directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)

    normalized = _normalize_parts(parts)
    meshes, triangles, all_pts_mm = _tessellate_all(normalized)
    part_ids = [usd_id for _, usd_id, _ in normalized]

    if assembly is not None:
        asm = json.loads(json.dumps(assembly))
        controls = asm.pop('controls', None)
    else:
        asm = {
            'version': 1,
            'root': part_ids[0],
            'parts': [{'id': pid, 'mesh': pid} for pid in part_ids],
            'connections': [],
            'sequences': [],
            'manufacturing': {'mode': 'print-in-place' if len(part_ids) == 1 else 'separate'},
        }
        controls = None

    if configure_assembly is not None:
        doc: dict[str, Any] = {'assembly': asm, 'controls': controls}
        returned = configure_assembly(doc)
        if isinstance(returned, dict) and 'assembly' in returned:
            doc = returned
        asm = doc['assembly']
        controls = doc.get('controls')

    require_separate_moving_parts(asm)

    usd_text = write_robot_usd(meshes, assembly=asm, controls=controls)
    data = usd_text.encode('utf-8')
    if not USD_MIN_BYTES <= len(data) <= USD_MAX_BYTES:
        raise ValueError('USD must fit 64 MiB')
    if b'@' in data:
        raise ValueError('USD must fit 64 MiB and contain no external assets; use embedded surface colours')

    # Round-trip validate before writing anything to disk.
    metadata = read_robot(usd_text)
    require_separate_moving_parts(metadata['assembly'])

    # Compute per-part print orientations for the revision receipt.
    print_orientations = {
        mesh['name']: analyze_part_print_orientation(
            mesh['points_mm'],
            mesh['triangles'],
            overhang_degrees=45.0,
            brep_shape=shape,
        )
        for mesh, (_, _, shape) in zip(meshes, normalized)
    }

    # Save immutable revision files.
    revision = directory / 'revisions' / uuid.uuid4().hex
    revision.mkdir(parents=True, exist_ok=False)
    usd_path = revision / 'model.usda'
    step_path = revision / 'model.step'
    brep_path = revision / 'model.brep'
    parts_dir = revision / 'parts'
    parts_dir.mkdir(parents=True, exist_ok=False)

    usd_path.write_bytes(data)
    _export_step_file(normalized, step_path)

    import build123d as bd
    compound_children = [
        (s if isinstance(s, bd.Shape) else bd.Shape(s)) for _, _, s in normalized
    ]
    _export_brep_file(bd.Compound(children=compound_children), brep_path)
    for _, usd_id, shape in normalized:
        _export_brep_file(shape, parts_dir / f'{usd_id}.brep')

    assembly_manifest = {
        'version': 1,
        'assembly': metadata['assembly'],
        'controls': metadata.get('controls'),
        'parts': [
            {
                'id': usd_id,
                'label': raw_label,
                'brep': f'parts/{usd_id}.brep',
                'color': list(_extract_color(shape)) if _extract_color(shape) is not None else None,
            }
            for raw_label, usd_id, shape in normalized
        ],
    }
    (revision / 'assembly.json').write_text(json.dumps(assembly_manifest, indent=2) + '\n', encoding='utf-8')

    low = all_pts_mm.min(axis=0)
    high = all_pts_mm.max(axis=0)
    report: dict[str, Any] = {
        'step': str(step_path),
        'brep': str(brep_path),
        'revisionUsd': str(usd_path),
        'preview': str(directory / 'model.usda'),
        'triangles': triangles,
        'parts': [part['mesh'] for part in metadata['assembly']['parts']],
        'dimensionsMm': {axis: float(high[i] - low[i]) for i, axis in enumerate('xyz')},
        'printReady': False,
        'printOrientations': print_orientations,
    }

    parts_by_name = {raw_label: shape for raw_label, _, shape in normalized}
    for _, usd_id, shape in normalized:
        parts_by_name.setdefault(usd_id, shape)
    badge_features = published_features(parts_by_name, metadata['assembly'], extra_features=features)
    receipt = dict(report, badgeFeatures=badge_features) if badge_features else report
    (revision / 'report.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')

    report.update(_publish_preview(directory, data))
    print('RUMI_MODEL ' + json.dumps(report))
    if check:
        report['checks'] = run_checks(usd_path, directory)
        print('RUMI_CHECKS ' + json.dumps(report['checks'], separators=(',', ':')))
    return report


def restore_revision(model_directory: str | Path, revision: str) -> dict[str, Any]:
    """Atomically restore a saved revision's exact USD without rebuilding or modifying its original.

    `revision` is a direct child directory name under `model_directory/revisions`. Both the saved
    self-contained USD and editable B-Rep/STEP original must exist there without symlinks.
    """
    directory = Path(model_directory).resolve()
    revisions = directory / 'revisions'
    if not isinstance(revision, str) or not revision or Path(revision).name != revision or revision in ('.', '..'):
        raise ValueError('Select one saved revision directory name')
    saved = revisions / revision
    if revisions.is_symlink() or saved.is_symlink() or not saved.is_dir() or saved.resolve().parent != revisions.resolve():
        raise ValueError('Revision must be inside this model')

    usd = saved / 'model.usda'
    step = saved / 'model.step'
    brep = saved / 'model.brep'
    if usd.is_symlink() or not usd.is_file():
        raise ValueError('Revision requires a saved model.usda file')
    if step.is_symlink() or brep.is_symlink():
        raise ValueError('Revision files may not be symbolic links')
    has_step = step.is_file()
    has_brep = brep.is_file()
    if not (has_step or has_brep):
        raise ValueError('Revision requires saved model.step or model.brep originals')

    if not USD_MIN_BYTES <= usd.stat().st_size <= USD_MAX_BYTES:
        raise ValueError('Saved USD must fit 64 MiB')
    data = usd.read_bytes()
    if not data.startswith(b'#usda 1.0') or b'@' in data:
        raise ValueError('Restore a self-contained ASCII USD layer')
    text = data.decode('utf-8')
    validate_usda_text(text)
    read_robot(text)

    report: dict[str, Any] = {
        'step': str(step) if has_step else None,
        'brep': str(brep) if has_brep else None,
        'revisionUsd': str(usd),
        'preview': str(directory / 'model.usda'),
        'printReady': False,
        'validation': 'pending',
        **_publish_preview(directory, data),
    }
    print('RUMI_MODEL ' + json.dumps(report))
    return report


# -------------------------------------------------------------------- B-Rep import helpers

def import_step(path: str | Path) -> Any:
    """Import an exact B-Rep STEP file using build123d."""
    import build123d as bd

    resolved = Path(path).resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f'STEP file not found: {resolved}')
    return bd.import_step(str(resolved))


def import_brep(path: str | Path) -> Any:
    """Import a lossless OpenCASCADE .brep file (or revision parts directory) using build123d."""
    import build123d as bd

    resolved = Path(path).resolve()
    if resolved.is_dir():
        manifest_path = resolved / 'assembly.json'
        if manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            loaded = []
            for entry in manifest.get('parts', []):
                part_path = resolved / entry['brep']
                shape = bd.import_brep(str(part_path))
                shape.label = entry.get('label') or entry['id']
                if entry.get('color') is not None:
                    shape.color = bd.Color(*entry['color'])
                loaded.append(shape)
            return loaded
        raise FileNotFoundError(f'No assembly.json in directory: {resolved}')
    if not resolved.is_file():
        raise FileNotFoundError(f'BREP file not found: {resolved}')
    return bd.import_brep(str(resolved))


# -------------------------------------------------------------------- control recipes & B-Rep cut

def _validate_fields_recipe(recipe: dict[str, Any]) -> None:
    fields, values = recipe.get('fields'), recipe.get('values')
    if not isinstance(fields, list) or not 1 <= len(fields) <= 12 or not isinstance(values, dict):
        raise ValueError('Provide 1–12 fields and numeric values')
    keys: set[str] = set()
    for field in fields:
        key = field.get('key')
        if key not in values or key in keys:
            raise ValueError('Invalid field binding')
        keys.add(key)
        if not isinstance(values[key], (int, float)) or not math.isfinite(values[key]) or not -1 <= values[key] <= 1:
            raise ValueError('Field values must be within -1..1')
        for name in ('origin', 'spacing', 'dimensions'):
            v = field.get(name)
            if not isinstance(v, list) or len(v) != 3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in v):
                raise ValueError('Invalid field ' + name)
        nx, ny, nz = field['dimensions']
        offsets = field.get('offsets')
        if not isinstance(offsets, list) or len(offsets) != nx * ny * nz * 3:
            raise ValueError('Invalid field offsets')
    if keys != set(values):
        raise ValueError('Every value must bind a field')


def _validate_surface_recipe(recipe: dict[str, Any]) -> None:
    parts = recipe.get('parts')
    if not isinstance(parts, list) or not parts or len(parts) > 16 or any(not isinstance(name, str) or not name for name in parts):
        raise ValueError('Surface deformation needs exact mesh names')
    form = recipe.get('form')
    if not isinstance(form, dict) or form.get('kind') not in ('profile', 'ring', 'channel', 'facet'):
        raise ValueError('Choose a surface form: profile, ring, channel or facet')
    values = recipe.get('values')
    if not isinstance(values, dict) or not values:
        raise ValueError('Surface recipe requires numeric values')
    for key, val in values.items():
        if not isinstance(val, (int, float)) or not math.isfinite(val) or abs(val) > 1000:
            raise ValueError('Invalid surface value: ' + str(key))


def load_control_recipe(path: str | Path, verify_source: bool = True) -> dict[str, Any]:
    """Load and validate a frozen v1 viewer_controls recipe JSON."""
    recipe = json.loads(Path(path).read_text(encoding='utf-8'))
    if (
        recipe.get('version') != 1
        or not recipe.get('frozen')
        or recipe.get('operation') not in ('bulge', 'bend', 'twist', 'taper', 'cut', 'fields', 'surface')
    ):
        raise ValueError('Use a frozen v1 recipe from viewer_controls')

    values = recipe.get('values', {})
    op = recipe['operation']
    if op == 'fields':
        _validate_fields_recipe(recipe)
    elif op == 'surface':
        _validate_surface_recipe(recipe)
    else:
        for key in ('amount', 'spread', 'peakX', 'peakY', 'falloff', 'angle'):
            val = values.get(key)
            if not isinstance(val, (int, float)) or not math.isfinite(val) or not 0 <= val <= 1:
                raise ValueError('Invalid control value: ' + key)
        for key in ('center', 'radii', 'direction'):
            vec = recipe.get(key)
            if not isinstance(vec, list) or len(vec) != 3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in vec):
                raise ValueError('Invalid frame: ' + key)
        if min(recipe['radii']) <= 0 or sum(n * n for n in recipe['direction']) < 1e-6 or not 0 < recipe['limit'] <= min(recipe['radii']):
            raise ValueError('Invalid deformation extent')

    parts = recipe.get('parts')
    if not isinstance(parts, list) or any(not isinstance(name, str) or not name for name in parts):
        raise ValueError('Recipe parts must be a list of exact mesh names')

    if verify_source:
        source_path = Path(recipe['source'])
        if hashlib.sha256(source_path.read_bytes()).hexdigest() != recipe['sourceHash']:
            raise ValueError('Source model changed; reopen shape controls')

    return recipe


def cut_plane(recipe: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Return (unit_normal, point_mm) of the retained half-space matching viewer cutPlane."""
    direction = np.asarray(recipe['direction'], dtype=np.float64)
    n = direction / np.linalg.norm(direction)
    up = np.array([0.0, 0.0, 1.0] if abs(n[2]) < 0.9 else [0.0, 1.0, 0.0], dtype=np.float64)
    u = np.cross(up, n)
    u = u / np.linalg.norm(u)
    v = np.cross(n, u)
    a = recipe['values']
    raw_normal = (
        n
        - v * math.tan((a['angle'] - 0.5) * math.pi * 2.0 / 3.0)
        - u * math.tan((a['spread'] - 0.5) * math.pi * 2.0 / 3.0)
    )
    normal = raw_normal / np.linalg.norm(raw_normal)
    point = np.asarray(recipe['center'], dtype=np.float64) + n * ((a['amount'] * 2.0 - 1.0) * float(recipe['limit']))
    return normal, point


def cut_solid(part: Any, recipe: dict[str, Any]) -> Any:
    """Apply a frozen `cut` viewer_controls recipe as an exact B-Rep half-space intersection.

    Retains the half-space `(x - point) · normal >= 0`, preserving `.label` and `.color`.
    """
    import build123d as bd

    if recipe.get('operation') != 'cut':
        raise ValueError('cut_solid requires a frozen cut recipe')
    normal, point = cut_plane(recipe)

    shape = part if isinstance(part, bd.Shape) else bd.Shape(part)
    bbox = shape.bounding_box()
    corners = np.array([
        [x, y, z]
        for x in (bbox.min.X, bbox.max.X)
        for y in (bbox.min.Y, bbox.max.Y)
        for z in (bbox.min.Z, bbox.max.Z)
    ], dtype=np.float64)
    extent = float(np.max(np.linalg.norm(corners - point, axis=1))) * 2.0 + 10.0

    plane = bd.Plane(
        origin=bd.Vector(float(point[0]), float(point[1]), float(point[2])),
        z_dir=bd.Vector(float(normal[0]), float(normal[1]), float(normal[2])),
    )
    box_loc = plane.location * bd.Pos(0, 0, extent)
    cutter = box_loc * bd.Box(extent * 2.0, extent * 2.0, extent * 2.0)

    trimmed = shape.intersect(cutter)
    if trimmed is None or not trimmed.solids():
        raise ValueError('The cut removes the entire solid; reopen controls and adjust the cut plane')

    if len(trimmed.solids()) == 1:
        result = trimmed.solids()[0]
    else:
        result = trimmed
    if getattr(part, 'label', None):
        result.label = part.label
    color = _extract_color(part)
    if color is not None:
        result.color = bd.Color(*color)
    return result


def summarize_control_recipe(recipe: dict[str, Any]) -> dict[str, Any]:
    """Summarize a frozen viewer_controls recipe into exact mm B-Rep engineering parameters.

    For `cut` recipes, includes the exact plane normal and origin for `cut_solid()`.
    For visual deformation recipes (`bulge`, `bend`, `twist`, `taper`, `fields`, `surface`),
    returns quantitative dimensions, offsets, angles, and region bounds so a CAD script
    can translate the kid's visual intent into exact parametric build123d features.
    """
    op = recipe['operation']
    summary: dict[str, Any] = {
        'operation': op,
        'parts': list(recipe.get('parts', [])),
        'exactBRepHelper': 'cut_solid(part, recipe)' if op == 'cut' else None,
    }
    if op == 'cut':
        normal, point = cut_plane(recipe)
        summary['plane'] = {
            'originMm': [round(float(v), 3) for v in point],
            'retainedNormal': [round(float(v), 5) for v in normal],
        }
        return summary

    if op in ('bulge', 'bend', 'twist', 'taper'):
        a = recipe['values']
        direction = np.asarray(recipe['direction'], dtype=np.float64)
        n = direction / np.linalg.norm(direction)
        up = np.array([0.0, 0.0, 1.0] if abs(n[2]) < 0.9 else [0.0, 1.0, 0.0], dtype=np.float64)
        u = np.cross(up, n)
        u = u / np.linalg.norm(u)
        v = np.cross(n, u)
        radii = [float(r) for r in recipe['radii']]
        peak_center = (
            np.asarray(recipe['center'], dtype=np.float64)
            + u * ((a['peakX'] - 0.5) * radii[0])
            + v * ((a['peakY'] - 0.5) * radii[1])
        )
        strength = a['amount'] * 2.0 - 1.0
        spread = 0.5 + a['spread']
        summary['region'] = {
            'centerMm': [round(float(x), 3) for x in peak_center],
            'direction': [round(float(x), 5) for x in n],
            'effectiveRadiiMm': [round(r * spread, 3) for r in radii],
            'falloffExponent': round(1.5 + 4.0 * a['falloff'], 3),
        }
        if op == 'bulge':
            tilt_deg = (a['angle'] - 0.5) * 120.0
            summary['amplitudeMm'] = round(strength * float(recipe['limit']), 3)
            summary['tiltDegrees'] = round(tilt_deg, 2)
        elif op == 'taper':
            summary['scaleFactor'] = round(1.0 + strength * 0.6, 4)
        else:
            summary['maxAngleDegrees'] = round(strength * 90.0, 2)
        return summary

    if op == 'fields':
        field_summaries = []
        for field in recipe['fields']:
            key = field['key']
            val = float(recipe['values'][key])
            offsets = np.asarray(field['offsets'], dtype=np.float64).reshape(-1, 3) * val
            mags = np.linalg.norm(offsets, axis=1)
            max_idx = int(np.argmax(mags)) if len(mags) else 0
            origin = np.asarray(field['origin'], dtype=np.float64)
            spacing = np.asarray(field['spacing'], dtype=np.float64)
            dims = np.asarray(field['dimensions'], dtype=np.int64)
            extent = origin + spacing * (dims - 1)
            field_summaries.append({
                'key': key,
                'value': round(val, 4),
                'boxMinMm': [round(float(x), 3) for x in origin],
                'boxMaxMm': [round(float(x), 3) for x in extent],
                'maxDisplacementMm': round(float(mags[max_idx]) if len(mags) else 0.0, 3),
                'peakVectorMm': [round(float(x), 3) for x in offsets[max_idx]] if len(mags) else [0.0, 0.0, 0.0],
            })
        summary['fields'] = field_summaries
        return summary

    if op == 'surface':
        summary['form'] = recipe['form']
        summary['values'] = {k: round(float(v), 4) for k, v in recipe['values'].items()}
        if 'uAt' in recipe:
            summary['frontAngleDegrees'] = float(recipe['uAt'])
        return summary

    return summary
