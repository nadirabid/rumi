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
_normalize_color = _robot_usd['_normalize_color']
published_features = _evidence['published_features']
weld_mesh = _validator['weld_mesh']
analyze_part_print_orientation = _validator['analyze_part_print_orientation']

_FACE_COLORS_ATTR = '_rumi_face_colors'
_REGION_PAINTERS_ATTR = '_rumi_region_painters'

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
    return _normalize_color(getattr(shape, 'color', None))


def _resolve_face_color(
    raw_face: Any,
    face_bindings: list[tuple[Any, tuple[float, float, float, float]]],
    fallback: tuple[float, float, float, float] | None,
) -> tuple[float, float, float, float] | None:
    """Resolve the color for one TopoDS_Face (last matching binding wins; IsSame before IsPartner)."""
    for target, rgba in reversed(face_bindings):
        if raw_face.IsSame(target):
            return rgba
    for target, rgba in reversed(face_bindings):
        if raw_face.IsPartner(target):
            return rgba
    return fallback


def paint_faces(part: Any, faces: Any, color: Any) -> Any:
    """Assign a surface color to specific B-Rep faces on `part`.

    Args:
        part: A `build123d` `Shape`/`Part`/`Solid`.
        faces: A single `Face`, an iterable of `Face` objects, or a predicate `fn(face) -> bool`.
        color: RGB/RGBA tuple in 0..1, `build123d.Color`, or hex string (`'#rrggbb'` / `'#rrggbbaa'`).

    Returns:
        `part` (for chaining).
    """
    import build123d as bd

    rgba = _normalize_color(color)
    if rgba is None:
        raise ValueError('paint_faces requires a non-None color')
    bd_shape = part if isinstance(part, bd.Shape) else bd.Shape(part)
    if callable(faces):
        selected = [f for f in bd_shape.faces() if faces(f)]
    elif isinstance(faces, bd.Face) or type(faces).__name__ == 'TopoDS_Face':
        selected = [faces]
    else:
        selected = list(faces)

    bindings = list(getattr(part, _FACE_COLORS_ATTR, ()))
    for face in selected:
        raw = face.wrapped if hasattr(face, 'wrapped') else face
        bindings.append((raw, rgba))
    setattr(part, _FACE_COLORS_ATTR, bindings)
    return part


def paint_regions(part: Any, painter: Callable[[np.ndarray, np.ndarray], Any]) -> Any:
    """Attach a per-triangle color callback `painter(centroids_mm, normals)` to `part`.

    `centroids_mm` and `normals` are `(T, 3)` float64 arrays in model-local millimetres (Z-up).
    Return either an `(T, 3)`/`(T, 4)` float array in `0..1` (rows containing `NaN` keep their
    existing color) or a length-`T` sequence of colors/`None`.
    """
    if not callable(painter):
        raise TypeError('paint_regions requires a callable painter(centroids_mm, normals)')
    painters = list(getattr(part, _REGION_PAINTERS_ATTR, ()))
    painters.append(painter)
    setattr(part, _REGION_PAINTERS_ATTR, painters)
    return part


def _tool_to_ocp_shape(tool: Any, center_mm: np.ndarray, span_mm: float) -> Any:
    """Convert a Plane, Face, Shell, Solid, or TopoDS_Shape into a splitting tool shape."""
    import build123d as bd
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    if isinstance(tool, bd.Plane):
        orig = np.array([tool.origin.X, tool.origin.Y, tool.origin.Z], dtype=np.float64)
        z_dir = np.array([tool.z_dir.X, tool.z_dir.Y, tool.z_dir.Z], dtype=np.float64)
        z_norm = float(np.linalg.norm(z_dir))
        if z_norm < 1e-12:
            raise ValueError('split_faces: plane normal must be nonzero')
        z_dir = z_dir / z_norm
        # Project solid center onto the plane so the bounded tool face spans the entire part.
        proj = center_mm - float(np.dot(center_mm - orig, z_dir)) * z_dir
        pln = gp_Pln(gp_Pnt(float(proj[0]), float(proj[1]), float(proj[2])), gp_Dir(float(z_dir[0]), float(z_dir[1]), float(z_dir[2])))
        return BRepBuilderAPI_MakeFace(pln, -span_mm, span_mm, -span_mm, span_mm).Face()
    if hasattr(tool, 'wrapped'):
        return tool.wrapped
    if type(tool).__name__.startswith('TopoDS_'):
        return tool
    raise TypeError(f'split_faces tool must be a Plane or Shape, got {type(tool).__name__}')


def split_faces(part: Any, *tools: Any) -> Any:
    """Split the boundary B-Rep faces of a single closed solid along planes or faces.

    Preserves the part as one valid closed `Solid` with identical volume so `paint_faces`
    can assign crisp multi-color regions without diagonal triangle jaggies.
    """
    import build123d as bd
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Splitter
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.BRepCheck import BRepCheck_Analyzer, BRepCheck_NoError, BRepCheck_Shell
    from OCP.BRepLib import BRepLib
    from OCP.collections import List_TopoDS_Shape
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    if not tools:
        return part
    bd_shape = part if isinstance(part, bd.Shape) else bd.Shape(part)
    solids = bd_shape.solids()
    if len(solids) != 1:
        raise ValueError(f'split_faces requires a single closed solid (got {len(solids)})')
    orig_vol = float(bd_shape.volume)
    bbox = bd_shape.bounding_box()
    center_mm = np.array([
        0.5 * (bbox.min.X + bbox.max.X),
        0.5 * (bbox.min.Y + bbox.max.Y),
        0.5 * (bbox.min.Z + bbox.max.Z),
    ], dtype=np.float64)
    diag = math.sqrt(
        (bbox.max.X - bbox.min.X) ** 2
        + (bbox.max.Y - bbox.min.Y) ** 2
        + (bbox.max.Z - bbox.min.Z) ** 2
    )
    span_mm = max(100.0, diag * 2.0)

    ocp_tools = List_TopoDS_Shape()
    for tool in tools:
        ocp_tools.Append(_tool_to_ocp_shape(tool, center_mm, span_mm))

    sewn_shells: list[Any] = []
    shell_exp = TopExp_Explorer(solids[0].wrapped, TopAbs_SHELL)
    while shell_exp.More():
        shell = shell_exp.Current()
        args = List_TopoDS_Shape()
        args.Append(shell)
        splitter = BRepAlgoAPI_Splitter()
        splitter.SetArguments(args)
        splitter.SetTools(ocp_tools)
        splitter.Build()
        if not splitter.IsDone():
            raise ValueError('split_faces: OpenCASCADE face split failed')
        sew = BRepBuilderAPI_Sewing(1e-6)
        fexp = TopExp_Explorer(splitter.Shape(), TopAbs_FACE)
        while fexp.More():
            sew.Add(fexp.Current())
            fexp.Next()
        sew.Perform()
        sewed = sew.SewedShape()
        if sewed.ShapeType() == TopAbs_SHELL:
            candidate_shell = TopoDS.Shell(sewed)
        else:
            inner_exp = TopExp_Explorer(sewed, TopAbs_SHELL)
            if not inner_exp.More():
                raise ValueError('split_faces: sewing split faces did not produce a closed shell')
            candidate_shell = TopoDS.Shell(inner_exp.Current())
        if BRepCheck_Shell(candidate_shell).Closed() != BRepCheck_NoError:
            raise ValueError('split_faces: split shell is not watertight')
        candidate_shell.Closed(True)
        sewn_shells.append(candidate_shell)
        shell_exp.Next()

    if not sewn_shells:
        raise ValueError('split_faces: solid has no boundary shells')
    mk_solid = BRepBuilderAPI_MakeSolid(sewn_shells[0])
    for extra_shell in sewn_shells[1:]:
        mk_solid.Add(extra_shell)
    solid = mk_solid.Solid()
    fixer = ShapeFix_Solid(solid)
    fixer.Perform()
    solid = TopoDS.Solid(fixer.Solid())
    BRepLib.OrientClosedSolid_s(solid)
    if not BRepCheck_Analyzer(solid).IsValid():
        raise ValueError('split_faces: resulting solid failed BRepCheck validation')
    result = bd.Part() + bd.Solid(solid)
    if abs(float(result.volume) - orig_vol) > max(1e-2, abs(orig_vol) * 1e-3):
        raise ValueError(f'split_faces: solid volume changed ({orig_vol:.3f} -> {result.volume:.3f} mm^3)')
    if getattr(part, 'label', None):
        result.label = part.label
    color = _extract_color(part)
    if color is not None:
        result.color = bd.Color(*color)
    if hasattr(part, '_rumi_features'):
        setattr(result, '_rumi_features', list(getattr(part, '_rumi_features')))
    if hasattr(part, _REGION_PAINTERS_ATTR):
        setattr(result, _REGION_PAINTERS_ATTR, list(getattr(part, _REGION_PAINTERS_ATTR)))
    return result


def _apply_region_painters(
    pts_mm: np.ndarray,
    tris: np.ndarray,
    tri_colors: list[tuple[float, float, float, float] | None],
    painters: list[Callable[[np.ndarray, np.ndarray], Any]],
) -> None:
    """Evaluate attached per-triangle region painters on welded (centroids_mm, normals)."""
    if not painters or len(tris) == 0:
        return
    p0 = pts_mm[tris[:, 0]]
    p1 = pts_mm[tris[:, 1]]
    p2 = pts_mm[tris[:, 2]]
    centroids = (p0 + p1 + p2) / 3.0
    raw_normals = np.cross(p1 - p0, p2 - p0)
    lengths = np.linalg.norm(raw_normals, axis=1)
    safe = np.where(lengths > 1e-18, lengths, 1.0)
    normals = raw_normals / safe[:, None]
    normals[lengths <= 1e-18] = np.array([0.0, 0.0, 1.0])

    n_tris = len(tris)
    for painter in painters:
        painted = painter(centroids, normals)
        if painted is None:
            continue
        if isinstance(painted, np.ndarray):
            if painted.ndim != 2 or painted.shape[0] != n_tris or painted.shape[1] not in (3, 4):
                raise ValueError(f'Region painter array must have shape ({n_tris}, 3 or 4), got {painted.shape}')
            arr = painted.astype(np.float64, copy=False)
            finite_mask = np.isfinite(arr).all(axis=1)
            for idx in np.flatnonzero(finite_mask):
                row = arr[idx]
                r = max(0.0, min(1.0, float(row[0])))
                g = max(0.0, min(1.0, float(row[1])))
                b = max(0.0, min(1.0, float(row[2])))
                a = max(0.0, min(1.0, float(row[3]))) if arr.shape[1] == 4 else 1.0
                tri_colors[int(idx)] = (r, g, b, a)
        else:
            seq = list(painted)
            if len(seq) != n_tris:
                raise ValueError(f'Region painter sequence length ({len(seq)}) must match triangles ({n_tris})')
            for idx, entry in enumerate(seq):
                if entry is not None:
                    tri_colors[idx] = _normalize_color(entry)


def _serialize_face_colors(shape: Any) -> list[list[Any]] | None:
    """Serialize non-base per-face colors by B-Rep face index for assembly.json."""
    import build123d as bd

    bindings = list(getattr(shape, _FACE_COLORS_ATTR, ()))
    if not bindings:
        return None
    bd_shape = shape if isinstance(shape, bd.Shape) else bd.Shape(shape)
    out: list[list[Any]] = []
    for idx, face in enumerate(bd_shape.faces()):
        rgba = _resolve_face_color(face.wrapped, bindings, None)
        if rgba is not None:
            out.append([idx, list(rgba)])
    return out if out else None


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


def tessellate_shape_with_faces(
    shape: Any,
    deflection: float = 0.05,
    angular_deflection: float = 0.25,
) -> tuple[np.ndarray, np.ndarray, list[tuple[float, float, float, float] | None] | None]:
    """Tessellate a build123d/OCP shape in mm, welding vertices and tracking per-triangle colors."""
    import build123d as bd
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_Orientation
    from OCP.TopLoc import TopLoc_Location

    bd_shape = shape if isinstance(shape, bd.Shape) else bd.Shape(shape)
    if bd_shape.wrapped is None:
        raise ValueError('Cannot tessellate an empty shape')

    base_color = _extract_color(shape)
    face_bindings = list(getattr(shape, _FACE_COLORS_ATTR, ()))
    region_painters = list(getattr(shape, _REGION_PAINTERS_ATTR, ()))

    bd_shape.mesh(deflection, angular_deflection)

    pts_list: list[tuple[float, float, float]] = []
    tris_list: list[tuple[int, int, int]] = []
    tri_colors: list[tuple[float, float, float, float] | None] = []
    has_face_override = bool(region_painters)
    offset = 0

    for face in bd_shape.faces():
        raw_face = face.wrapped
        if raw_face is None:
            continue
        loc = TopLoc_Location()
        poly = BRep_Tool.Triangulation_s(raw_face, loc)
        if poly is None:
            continue
        trsf = loc.Transformation()
        reverse = raw_face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED

        direct_color = _extract_color(face)
        face_rgba = _resolve_face_color(raw_face, face_bindings, direct_color if direct_color is not None else base_color)
        if face_rgba != base_color:
            has_face_override = True

        n_nodes = poly.NbNodes()
        for i in range(1, n_nodes + 1):
            node = poly.Node(i).Transformed(trsf)
            pts_list.append((node.X(), node.Y(), node.Z()))

        for tri in poly.Triangles():
            if reverse:
                tris_list.append((tri.Value(1) + offset - 1, tri.Value(3) + offset - 1, tri.Value(2) + offset - 1))
            else:
                tris_list.append((tri.Value(1) + offset - 1, tri.Value(2) + offset - 1, tri.Value(3) + offset - 1))
            tri_colors.append(face_rgba)

        offset += n_nodes

    if not pts_list or not tris_list:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int64), None
    pts = np.asarray(pts_list, dtype=np.float64)
    tri_arr = np.asarray(tris_list, dtype=np.int64)
    if not np.isfinite(pts).all():
        raise ValueError('Nonfinite coordinates in tessellated B-Rep shape')

    welded_pts, welded_tris, valid_mask = weld_mesh(pts, tri_arr, dist=1e-5, return_mask=True)
    if not has_face_override:
        return welded_pts, welded_tris, None

    filtered_colors = [c for c, keep in zip(tri_colors, valid_mask) if keep]
    _apply_region_painters(welded_pts, welded_tris, filtered_colors, region_painters)
    return welded_pts, welded_tris, filtered_colors


def tessellate_shape(
    shape: Any,
    deflection: float = 0.05,
    angular_deflection: float = 0.25,
) -> tuple[np.ndarray, np.ndarray]:
    """Tessellate a build123d/OCP shape in mm and weld vertices at 1e-5 mm."""
    pts, tris, _ = tessellate_shape_with_faces(shape, deflection=deflection, angular_deflection=angular_deflection)
    return pts, tris


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
            pts_mm, tris, face_colors = tessellate_shape_with_faces(
                shape, deflection=deflection, angular_deflection=angular
            )
            if len(tris) == 0:
                raise ValueError(f'Part {raw_label!r} produced empty geometry')
            total_tris += len(tris)
            all_pts_list.append(pts_mm)
            mesh_entry: dict[str, Any] = {
                'name': usd_id,
                'raw_label': raw_label,
                'points_mm': pts_mm,
                'points': pts_mm * 0.001,  # USD uses metres, Z-up
                'triangles': tris,
                'color': _extract_color(shape),
            }
            if face_colors is not None:
                mesh_entry['face_colors'] = face_colors
            meshes.append(mesh_entry)
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
                **(
                    {'faceColors': serialized_faces}
                    if (serialized_faces := _serialize_face_colors(shape)) is not None
                    else {}
                ),
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
                if entry.get('faceColors'):
                    all_faces = list(shape.faces())
                    for face_idx, rgba in entry['faceColors']:
                        if isinstance(face_idx, int) and 0 <= face_idx < len(all_faces):
                            paint_faces(shape, all_faces[face_idx], rgba)
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
