"""Pure-Python ASCII #usda 1.0 writer and parser for Rumi CAD assemblies (zero pxr dependency).

Produces self-contained static ASCII USD layers compatible with Three.js USDAParser/USDComposer,
viewer/usd.js, viewer/viewport/usd.js, and OpenUSD Isaac/UsdPhysics schemas.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

USD_MIN_BYTES = 10
USD_MAX_BYTES = 64 * 1024 * 1024
FORBIDDEN_USD_TOKENS = re.compile(
    r'\b(subLayers|references|payload|variants|variantSet|inherits|specializes|timeSamples|clips)\b'
)
VALID_RETAINERS = ('rigid', 'bayonet', 'threaded', 'snap', 'friction')
JOINT_TYPE_TO_KIND = {
    'PhysicsFixedJoint': 'fixed',
    'PhysicsRevoluteJoint': 'revolute',
    'PhysicsPrismaticJoint': 'prismatic',
}
KIND_TO_JOINT_TYPE = {v: k for k, v in JOINT_TYPE_TO_KIND.items()}
AXIS_VECTORS = {
    'X': np.array([1.0, 0.0, 0.0], dtype=np.float64),
    'Y': np.array([0.0, 1.0, 0.0], dtype=np.float64),
    'Z': np.array([0.0, 0.0, 1.0], dtype=np.float64),
}


def make_valid_identifier(name: str) -> str:
    """Match OpenUSD Tf.MakeValidIdentifier for prim and joint names."""
    if not isinstance(name, str) or not name:
        return '_'
    chars = [ch if (ch.isalnum() or ch == '_') else '_' for ch in name]
    if not (chars[0].isalpha() or chars[0] == '_'):
        chars[0] = '_'
    return ''.join(chars)


def validate_usda_text(text: str) -> str:
    """Validate the portable self-contained ASCII USD profile matching viewer/usd.js."""
    raw = text.encode('utf-8')
    if not USD_MIN_BYTES <= len(raw) <= USD_MAX_BYTES:
        raise ValueError('USD must be between 10 bytes and 64 MiB')
    if not text.startswith('#usda 1.0'):
        raise ValueError('Export a self-contained ASCII USD layer as model.usda')
    if '@' in text or FORBIDDEN_USD_TOKENS.search(text):
        raise ValueError('Flatten USD into one static layer without asset paths, references, variants or animation')
    return text


def require_separate_moving_parts(assembly: dict[str, Any]) -> None:
    """Reject printed-assembled motion without changing legacy model declarations."""
    connections = assembly.get('connections', ())
    mode = assembly.get('manufacturing', {}).get('mode')
    if any(joint.get('kind') != 'fixed' for joint in connections) and mode != 'separate':
        raise ValueError(
            'Moving parts must be printed separately and assembled afterward. '
            'Redesign captive connectors and publish with mode="separate"; '
            'changing the label alone does not make assembly possible.'
        )


def _fmt_float(value: float) -> str:
    """Format a finite float concisely for ASCII USDA without -0."""
    v = float(value)
    if not math.isfinite(v):
        raise ValueError('USD numeric values must be finite')
    if abs(v) < 1e-12:
        return '0'
    text = f'{v:.7g}'
    return '0' if text in ('-0', '-0.0') else text


def _quote_usd_string(value: str) -> str:
    """Encode a Python string as a double-quoted ASCII USDA string literal."""
    escaped = (
        value.replace('\\', '\\\\')
        .replace('"', '\\"')
        .replace('\n', '\\n')
        .replace('\r', '\\r')
        .replace('\t', '\\t')
    )
    return f'"{escaped}"'


def _quat_from_x_to_axis(axis: Any) -> tuple[float, float, float, float]:
    """Return unit quaternion (w, x, y, z) rotating +X (1, 0, 0) onto normalized `axis`."""
    vec = np.asarray(axis, dtype=np.float64)
    if vec.shape != (3,) or not np.isfinite(vec).all():
        raise ValueError('Joint axis must be a finite 3D vector')
    length = float(np.linalg.norm(vec))
    if length < 1e-9:
        raise ValueError('Joint axis must be nonzero')
    d = vec / length
    dot = float(d[0])
    if dot >= 1.0 - 1e-12:
        return (1.0, 0.0, 0.0, 0.0)
    if dot <= -1.0 + 1e-12:
        return (0.0, 0.0, 0.0, 1.0)
    # cross((1, 0, 0), d) = (0, -d[2], d[1])
    w = 1.0 + dot
    x = 0.0
    y = -float(d[2])
    z = float(d[1])
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    return (w / norm, x / norm, y / norm, z / norm)


def _quat_rotate_vec(quat_wxyz: tuple[float, float, float, float], vec: np.ndarray) -> np.ndarray:
    """Rotate 3D vector `vec` by unit quaternion (w, x, y, z)."""
    w, x, y, z = quat_wxyz
    qvec = np.array([x, y, z], dtype=np.float64)
    uv = np.cross(qvec, vec)
    uuv = np.cross(qvec, uv)
    return vec + 2.0 * (w * uv + uuv)


def _quat_to_mat3(quat_wxyz: tuple[float, float, float, float]) -> np.ndarray:
    """Convert unit quaternion (w, x, y, z) to 3x3 rotation matrix."""
    w, x, y, z = quat_wxyz
    return np.array([
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ], dtype=np.float64)


def _euler_xyz_usd_to_mat3(deg_xyz: list[float]) -> np.ndarray:
    """Convert USD xformOp:rotateXYZ (degrees) to column-vector 3x3 rotation matrix.

    USD applies Rx then Ry then Rz to row vectors, which is Rz @ Ry @ Rx for column vectors.
    """
    rx, ry, rz = (math.radians(float(a)) for a in deg_xyz)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return mz @ my @ mx


_DEFAULT_SUBSET_COLOR = (0.78, 0.78, 0.78, 1.0)


def _normalize_color(color: Any) -> tuple[float, float, float, float] | None:
    """Normalize an optional RGB(A) tuple, hex string ('#rrggbb[aa]'), or build123d Color to (r, g, b, a) in 0..1."""
    if color is None:
        return None
    if isinstance(color, str):
        text = color.strip()
        if not text.startswith('#') or len(text) not in (7, 9):
            raise ValueError(f'Color string must be #rrggbb or #rrggbbaa, got {color!r}')
        try:
            r = int(text[1:3], 16) / 255.0
            g = int(text[3:5], 16) / 255.0
            b = int(text[5:7], 16) / 255.0
            a = int(text[7:9], 16) / 255.0 if len(text) == 9 else 1.0
        except ValueError as exc:
            raise ValueError(f'Invalid hex color {color!r}') from exc
        return (r, g, b, a)
    if hasattr(color, '__iter__'):
        values = [float(c) for c in color]
    else:
        return None
    if len(values) == 3:
        values.append(1.0)
    if len(values) != 4 or not all(math.isfinite(c) for c in values):
        raise ValueError('Part color must have 3 or 4 finite RGB(A) channels')
    return tuple(max(0.0, min(1.0, c)) for c in values)  # type: ignore[return-value]


def _material_key(rgba: tuple[float, float, float, float]) -> str:
    """Return a deterministic USD Material prim name for an RGBA color."""
    r8, g8, b8, a8 = (int(round(c * 255)) for c in rgba)
    return f'rumi_{r8:02x}{g8:02x}{b8:02x}' if a8 == 255 else f'rumi_{r8:02x}{g8:02x}{b8:02x}_{a8:02x}'


def _compute_face_varying_normals(
    points: np.ndarray,
    triangles: np.ndarray,
    crease_degrees: float = 35.0,
) -> np.ndarray:
    """Compute crisp-edge, smooth-curve faceVarying normals (shape [T*3, 3])."""
    n_tris = len(triangles)
    if n_tris == 0:
        return np.zeros((0, 3), dtype=np.float64)
    p0 = points[triangles[:, 0]]
    p1 = points[triangles[:, 1]]
    p2 = points[triangles[:, 2]]
    raw = np.cross(p1 - p0, p2 - p0)
    lengths = np.linalg.norm(raw, axis=1)
    safe_len = np.where(lengths > 1e-18, lengths, 1.0)
    face_normals = raw / safe_len[:, None]
    face_normals[lengths <= 1e-18] = np.array([0.0, 0.0, 1.0])

    cos_threshold = math.cos(math.radians(crease_degrees))
    vert_to_tris: dict[int, list[int]] = {}
    for tri_idx in range(n_tris):
        i0, i1, i2 = int(triangles[tri_idx, 0]), int(triangles[tri_idx, 1]), int(triangles[tri_idx, 2])
        vert_to_tris.setdefault(i0, []).append(tri_idx)
        vert_to_tris.setdefault(i1, []).append(tri_idx)
        vert_to_tris.setdefault(i2, []).append(tri_idx)

    out = np.empty((n_tris * 3, 3), dtype=np.float64)
    for tri_idx in range(n_tris):
        fn = face_normals[tri_idx]
        for corner in range(3):
            v_idx = int(triangles[tri_idx, corner])
            neighbors = vert_to_tris[v_idx]
            if len(neighbors) == 1:
                out[tri_idx * 3 + corner] = fn
                continue
            nb_normals = face_normals[neighbors]
            dots = nb_normals @ fn
            mask = dots >= cos_threshold
            if np.count_nonzero(mask) <= 1:
                out[tri_idx * 3 + corner] = fn
            else:
                # Weight by triangle area (raw cross length) for stable smooth shading.
                weights = lengths[neighbors][mask]
                avg = (nb_normals[mask] * weights[:, None]).sum(axis=0)
                norm = float(np.linalg.norm(avg))
                out[tri_idx * 3 + corner] = avg / norm if norm > 1e-18 else fn
    return out


def _format_rel(name: str, targets: list[str], indent: str = '    ') -> str:
    """Format a USD relationship declaration."""
    if not targets:
        return f'{indent}rel {name} = []'
    if len(targets) == 1:
        return f'{indent}rel {name} = <{targets[0]}>'
    items = ',\n'.join(f'{indent}    <{t}>' for t in targets)
    return f'{indent}rel {name} = [\n{items},\n{indent}]'


def _format_vec3_array(arr: np.ndarray) -> str:
    """Format an Nx3 array as a USDA tuple array [(x, y, z), ...]."""
    return '[' + ', '.join(
        f'({_fmt_float(row[0])}, {_fmt_float(row[1])}, {_fmt_float(row[2])})'
        for row in arr
    ) + ']'


def write_robot_usd(
    meshes: list[dict[str, Any]],
    assembly: dict[str, Any] | None = None,
    controls: list[dict[str, Any]] | None = None,
    default_prim: str = 'Model',
) -> str:
    """Serialize triangulated meshes and assembly metadata to a self-contained ASCII #usda 1.0 layer.

    Args:
        meshes: List of dicts with keys:
            - `name`: part name (sanitized via make_valid_identifier)
            - `points`: Nx3 array-like of vertex coordinates in **metres** (Z-up)
            - `triangles`: Tx3 array-like of integer vertex indices
            - `normals`: optional (T*3)x3 faceVarying normals (computed if omitted)
            - `color`: optional (r, g, b) or (r, g, b, a) in 0..1 (or '#rrggbb[aa]')
            - `face_colors`: optional per-triangle color sequence of length T (entries may be None to inherit `color`)
        assembly: Optional assembly dict (version 1) with root, parts, connections, sequences, manufacturing.
        controls: Optional list of rumi:motionControls widget declarations.
        default_prim: Root prim name (default 'Model').

    Returns:
        Self-contained ASCII #usda 1.0 string.
    """
    if not meshes:
        raise ValueError('No meshes to write to USD')
    root_name = make_valid_identifier(default_prim)
    root_path = f'/{root_name}'

    mesh_by_id: dict[str, dict[str, Any]] = {}
    ordered_ids: list[str] = []
    for item in meshes:
        pid = make_valid_identifier(item['name'])
        if pid in mesh_by_id:
            raise ValueError(f'Duplicate mesh identifier in USD export: {pid}')
        pts = np.asarray(item['points'], dtype=np.float64)
        tris = np.asarray(item['triangles'], dtype=np.int64)
        if pts.ndim != 2 or pts.shape[1] != 3 or len(pts) == 0:
            raise ValueError(f'Mesh {pid} has invalid points array')
        if not np.isfinite(pts).all():
            raise ValueError(f'Nonfinite coordinates in {pid}')
        if tris.ndim != 2 or tris.shape[1] != 3 or len(tris) == 0:
            raise ValueError(f'Mesh {pid} has invalid triangles array')
        raw_face_colors = item.get('face_colors')
        if raw_face_colors is not None and len(raw_face_colors) != len(tris):
            raise ValueError(f'Mesh {pid} face_colors length ({len(raw_face_colors)}) does not match triangles ({len(tris)})')
        mesh_by_id[pid] = {
            'id': pid,
            'points': pts,
            'triangles': tris,
            'normals': item.get('normals'),
            'color': _normalize_color(item.get('color')),
            'face_colors': raw_face_colors,
        }
        ordered_ids.append(pid)

    if assembly is None:
        assembly = {
            'version': 1,
            'root': ordered_ids[0],
            'parts': [{'id': pid, 'mesh': pid} for pid in ordered_ids],
            'connections': [],
            'sequences': [],
            'manufacturing': {'mode': 'print-in-place' if len(ordered_ids) == 1 else 'separate'},
        }
    else:
        assembly = json.loads(json.dumps(assembly))
        if 'manufacturing' not in assembly or not isinstance(assembly['manufacturing'], dict):
            assembly['manufacturing'] = {'mode': 'separate' if assembly.get('connections') else 'print-in-place'}

    require_separate_moving_parts(assembly)

    # Order links with assembly root first.
    root_part = make_valid_identifier(assembly['root'])
    if root_part not in mesh_by_id:
        raise ValueError(f'Assembly root {root_part!r} is not among exported meshes')
    link_ids = [root_part] + [pid for pid in ordered_ids if pid != root_part]
    link_paths = [f'{root_path}/{pid}' for pid in link_ids]

    # Build deduplicated UsdPreviewSurface materials for single-color and multi-color meshes.
    materials: dict[str, tuple[float, float, float, float]] = {}
    mesh_materials: dict[str, str] = {}
    mesh_subsets: dict[str, list[tuple[str, list[int]]]] = {}
    for pid in link_ids:
        mesh = mesh_by_id[pid]
        base_rgba = mesh['color']
        raw_face_colors = mesh['face_colors']
        if raw_face_colors is not None:
            fallback_rgba = base_rgba if base_rgba is not None else _DEFAULT_SUBSET_COLOR
            grouped: dict[str, list[int]] = {}
            for tri_idx, raw_fc in enumerate(raw_face_colors):
                rgba = _normalize_color(raw_fc) if raw_fc is not None else fallback_rgba
                if rgba is None:
                    rgba = fallback_rgba
                mat_name = _material_key(rgba)
                materials.setdefault(mat_name, rgba)
                grouped.setdefault(mat_name, []).append(tri_idx)
            if len(grouped) == 1:
                only_name = next(iter(grouped))
                mesh['color'] = materials[only_name]
                mesh_materials[pid] = f'{root_path}/Materials/{only_name}'
            elif len(grouped) > 1:
                dominant = min(grouped.keys(), key=lambda name: (-len(grouped[name]), name))
                mesh['color'] = materials[dominant]
                mesh_materials[pid] = f'{root_path}/Materials/{dominant}'
                mesh_subsets[pid] = [(name, grouped[name]) for name in sorted(grouped.keys())]
        elif base_rgba is not None:
            mat_name = _material_key(base_rgba)
            materials.setdefault(mat_name, base_rgba)
            mesh_materials[pid] = f'{root_path}/Materials/{mat_name}'

    # Prepare joints under /Model/Joints/<id>.
    raw_connections = assembly.get('connections', [])
    joint_records: list[dict[str, Any]] = []
    joint_paths: list[str] = []
    renamed_joints: dict[str, str] = {}
    seen_joint_ids: set[str] = set()
    for conn in raw_connections:
        jid = make_valid_identifier(conn['id'])
        if jid in seen_joint_ids:
            raise ValueError(f'Joint names collide after conversion to USD identifiers: {jid}')
        seen_joint_ids.add(jid)
        renamed_joints[conn['id']] = jid
        kind = conn['kind']
        if kind not in KIND_TO_JOINT_TYPE:
            raise ValueError(f'Unsupported joint kind: {kind}')
        parent_id = make_valid_identifier(conn['parent'])
        child_id = make_valid_identifier(conn['child'])
        if parent_id not in mesh_by_id or child_id not in mesh_by_id:
            raise ValueError(f'Joint {jid} references missing part ({parent_id}, {child_id})')
        jpath = f'{root_path}/Joints/{jid}'
        joint_paths.append(jpath)
        joint_records.append({
            'id': jid,
            'path': jpath,
            'kind': kind,
            'parent': parent_id,
            'child': child_id,
            'raw': conn,
        })

    lines: list[str] = [
        '#usda 1.0',
        '(',
        f'    defaultPrim = "{root_name}"',
        '    doc = "Rumi CAD"',
        '    metersPerUnit = 1',
        '    upAxis = "Z"',
        ')',
        '',
        f'def Xform "{root_name}" (',
        '    prepend apiSchemas = ["IsaacRobotAPI", "PhysicsArticulationRootAPI"]',
        ')',
        '{',
        _format_rel('isaac:physics:robotJoints', joint_paths),
        _format_rel('isaac:physics:robotLinks', link_paths),
    ]

    manufacturing = assembly['manufacturing']
    mode = manufacturing.get('mode', 'print-in-place')
    if mode not in ('print-in-place', 'separate'):
        raise ValueError(f'Invalid manufacturing mode: {mode}')

    if 'steps' in manufacturing and manufacturing['steps'] is not None:
        normalized_steps = []
        for step in manufacturing['steps']:
            part_id = make_valid_identifier(step['part'])
            entry: dict[str, Any] = {'part': part_id}
            if 'actions' in step:
                actions = []
                for action in step['actions']:
                    act = dict(action)
                    if 'mate' in act and isinstance(act['mate'], str):
                        act['mate'] = make_valid_identifier(act['mate'])
                    actions.append(act)
                entry['actions'] = actions
            elif 'path' in step:
                entry['path'] = [[float(v) for v in pt] for pt in step['path']]
            else:
                raise ValueError(f'Disassembly step for {part_id} requires path or actions')
            normalized_steps.append(entry)
        steps_json = json.dumps(normalized_steps, allow_nan=False, separators=(',', ':'))
        lines.append(f'    string rumi:disassembly = {_quote_usd_string(steps_json)}')

    lines.append(f'    token rumi:manufacturingMode = "{mode}"')

    if controls is not None:
        controls_json = json.dumps(controls, allow_nan=False, separators=(',', ':'))
        lines.append(f'    string rumi:motionControls = {_quote_usd_string(controls_json)}')

    sequences = assembly.get('sequences', [])
    if sequences:
        normalized_sequences = [
            {
                'id': item['id'],
                'waypoints': [
                    {renamed_joints.get(k, make_valid_identifier(k)): float(v) for k, v in wp.items()}
                    for wp in item['waypoints']
                ],
            }
            for item in sequences
        ]
        seq_json = json.dumps(normalized_sequences, allow_nan=False, separators=(',', ':'))
        lines.append(f'    string rumi:sequences = {_quote_usd_string(seq_json)}')

    # Emit Materials scope if any mesh has a color.
    if materials:
        lines.append('')
        lines.append('    def Scope "Materials"')
        lines.append('    {')
        for mat_name, rgba in sorted(materials.items()):
            mat_path = f'{root_path}/Materials/{mat_name}'
            r, g, b, a = rgba
            lines.extend([
                f'        def Material "{mat_name}"',
                '        {',
                f'            token outputs:surface.connect = <{mat_path}/PreviewSurface.outputs:surface>',
                '',
                '            def Shader "PreviewSurface"',
                '            {',
                '                uniform token info:id = "UsdPreviewSurface"',
                f'                color3f inputs:diffuseColor = ({_fmt_float(r)}, {_fmt_float(g)}, {_fmt_float(b)})',
                f'                float inputs:opacity = {_fmt_float(a)}',
                '                float inputs:roughness = 0.45',
                '                token outputs:surface',
                '            }',
                '        }',
            ])
        lines.append('    }')

    # Emit Mesh prims.
    for pid in link_ids:
        mesh = mesh_by_id[pid]
        pts = mesh['points']
        tris = mesh['triangles']
        normals = mesh['normals']
        if normals is None:
            normals = _compute_face_varying_normals(pts, tris)
        else:
            normals = np.asarray(normals, dtype=np.float64)
        low = pts.min(axis=0)
        high = pts.max(axis=0)
        schemas = ['IsaacLinkAPI', 'PhysicsRigidBodyAPI', 'PhysicsCollisionAPI']
        if pid in mesh_materials:
            schemas.append('MaterialBindingAPI')
        schemas_str = ', '.join(f'"{s}"' for s in schemas)
        face_counts = '[' + ', '.join(['3'] * len(tris)) + ']'
        face_indices = '[' + ', '.join(str(int(v)) for v in tris.reshape(-1)) + ']'

        lines.extend([
            '',
            f'    def Mesh "{pid}" (',
            '        active = true',
            f'        prepend apiSchemas = [{schemas_str}]',
            '    )',
            '    {',
            f'        float3[] extent = [({_fmt_float(low[0])}, {_fmt_float(low[1])}, {_fmt_float(low[2])}), ({_fmt_float(high[0])}, {_fmt_float(high[1])}, {_fmt_float(high[2])})]',
            f'        int[] faceVertexCounts = {face_counts}',
            f'        int[] faceVertexIndices = {face_indices}',
        ])
        if pid in mesh_materials:
            lines.append(f'        rel material:binding = <{mesh_materials[pid]}>')
            if pid not in mesh_subsets and mesh['color'] is not None:
                r, g, b, a = mesh['color']
                lines.append(f'        color3f[] primvars:displayColor = [({_fmt_float(r)}, {_fmt_float(g)}, {_fmt_float(b)})]')
                if a < 1.0:
                    lines.append(f'        float[] primvars:displayOpacity = [{_fmt_float(a)}]')
        lines.extend([
            f'        normal3f[] normals = {_format_vec3_array(normals)} (',
            '            interpolation = "faceVarying"',
            '        )',
            f'        point3f[] points = {_format_vec3_array(pts)}',
            '        uniform token subdivisionScheme = "none"',
        ])
        if pid in mesh_subsets:
            for mat_name, subset_indices in mesh_subsets[pid]:
                idx_str = '[' + ', '.join(str(i) for i in subset_indices) + ']'
                lines.extend([
                    '',
                    f'        def GeomSubset "{mat_name}" (',
                    '            prepend apiSchemas = ["MaterialBindingAPI"]',
                    '        )',
                    '        {',
                    '            uniform token elementType = "face"',
                    '            uniform token familyName = "materialBind"',
                    f'            int[] indices = {idx_str}',
                    f'            rel material:binding = <{root_path}/Materials/{mat_name}>',
                    '        }',
                ])
        lines.append('    }')

    # Emit Joints scope.
    if joint_records:
        lines.append('')
        lines.append('    def Scope "Joints"')
        lines.append('    {')
        for rec in joint_records:
            kind = rec['kind']
            conn = rec['raw']
            usd_type = KIND_TO_JOINT_TYPE[kind]
            jid = rec['id']
            parent_path = f'{root_path}/{rec["parent"]}'
            child_path = f'{root_path}/{rec["child"]}'
            lines.extend([
                f'        def {usd_type} "{jid}" (',
                '            prepend apiSchemas = ["IsaacJointAPI"]',
                '        )',
                '        {',
                f'            rel physics:body0 = <{parent_path}>',
                f'            rel physics:body1 = <{child_path}>',
                '            bool physics:jointEnabled = true',
            ])
            if kind == 'fixed':
                retainer = conn.get('retainer')
                if retainer is not None:
                    if retainer not in VALID_RETAINERS:
                        raise ValueError(f'Unsupported retainer kind on {jid}: {retainer}')
                has_axis = 'axis' in conn and conn['axis'] is not None
                if retainer in ('bayonet', 'threaded') and not has_axis:
                    raise ValueError(f'Fixed joint {jid} with retainer={retainer!r} requires a nonzero axis')
                pivot_m = [float(v) * 0.001 for v in conn.get('pivot', (0.0, 0.0, 0.0))]
                quat = _quat_from_x_to_axis(conn['axis']) if has_axis else (1.0, 0.0, 0.0, 0.0)
                if has_axis:
                    lines.append('            uniform token physics:axis = "X"')
                lines.append(f'            point3f physics:localPos0 = ({_fmt_float(pivot_m[0])}, {_fmt_float(pivot_m[1])}, {_fmt_float(pivot_m[2])})')
                lines.append(f'            point3f physics:localPos1 = ({_fmt_float(pivot_m[0])}, {_fmt_float(pivot_m[1])}, {_fmt_float(pivot_m[2])})')
                lines.append(f'            quatf physics:localRot0 = ({_fmt_float(quat[0])}, {_fmt_float(quat[1])}, {_fmt_float(quat[2])}, {_fmt_float(quat[3])})')
                lines.append(f'            quatf physics:localRot1 = ({_fmt_float(quat[0])}, {_fmt_float(quat[1])}, {_fmt_float(quat[2])}, {_fmt_float(quat[3])})')
                if retainer is not None:
                    lines.append(f'            token rumi:retainer = "{retainer}"')
            else:
                pivot_mm = conn['pivot']
                axis_vec = conn['axis']
                rng = conn['range']
                if len(rng) != 2 or not all(math.isfinite(float(v)) for v in rng):
                    raise ValueError(f'Moving joint {jid} requires finite lower and upper limits')
                pivot_m = [float(v) * 0.001 for v in pivot_mm]
                quat = _quat_from_x_to_axis(axis_vec)
                scale = 0.001 if kind == 'prismatic' else 1.0
                lines.append('            uniform token physics:axis = "X"')
                lines.append(f'            point3f physics:localPos0 = ({_fmt_float(pivot_m[0])}, {_fmt_float(pivot_m[1])}, {_fmt_float(pivot_m[2])})')
                lines.append(f'            point3f physics:localPos1 = ({_fmt_float(pivot_m[0])}, {_fmt_float(pivot_m[1])}, {_fmt_float(pivot_m[2])})')
                lines.append(f'            quatf physics:localRot0 = ({_fmt_float(quat[0])}, {_fmt_float(quat[1])}, {_fmt_float(quat[2])}, {_fmt_float(quat[3])})')
                lines.append(f'            quatf physics:localRot1 = ({_fmt_float(quat[0])}, {_fmt_float(quat[1])}, {_fmt_float(quat[2])}, {_fmt_float(quat[3])})')
                lines.append(f'            float physics:lowerLimit = {_fmt_float(float(rng[0]) * scale)}')
                lines.append(f'            float physics:upperLimit = {_fmt_float(float(rng[1]) * scale)}')
                if conn.get('control') is not None:
                    lines.append(f'            string rumi:control = {_quote_usd_string(str(conn["control"]))}')
            lines.append('        }')
        lines.append('    }')

    lines.append('}')
    text = '\n'.join(lines) + '\n'
    validate_usda_text(text)
    return text


# ----------------------------------------------------------------- pure-Python USDA parser

def _strip_block_comments(text: str) -> str:
    """Remove /* ... */ comments outside string literals."""
    if '/*' not in text:
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    in_str: str | None = None
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == in_str:
                in_str = None
            i += 1
        elif ch in ('"', "'"):
            in_str = ch
            out.append(ch)
            i += 1
        elif ch == '/' and i + 1 < n and text[i + 1] == '*':
            end = text.find('*/', i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _strip_line_comment(line: str) -> str:
    """Strip inline # comments outside quotes while preserving the #usda header."""
    if '#' not in line or line.lstrip().startswith('#usda'):
        return line
    in_str: str | None = None
    escaped = False
    for i, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == '\\' and in_str is not None:
            escaped = True
            continue
        if in_str is None:
            if ch in ('"', "'"):
                in_str = ch
            elif ch == '#':
                return line[:i].rstrip()
        elif ch == in_str:
            in_str = None
    return line


def _find_top_level_equals(line: str) -> int:
    """Return index of first '=' outside quoted strings, or -1."""
    in_str: str | None = None
    escaped = False
    for i, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == '\\' and in_str is not None:
            escaped = True
            continue
        if in_str is None:
            if ch in ('"', "'"):
                in_str = ch
            elif ch == '=':
                return i
        elif ch == in_str:
            in_str = None
    return -1


def _count_brackets_outside_strings(text: str) -> tuple[int, int]:
    """Count net '[' minus ']' outside quoted strings."""
    if '"' not in text and "'" not in text:
        return text.count('['), text.count(']')
    opens = closes = 0
    in_str: str | None = None
    escaped = False
    for ch in text:
        if escaped:
            escaped = False
            continue
        if ch == '\\' and in_str is not None:
            escaped = True
            continue
        if in_str is None:
            if ch in ('"', "'"):
                in_str = ch
            elif ch == '[':
                opens += 1
            elif ch == ']':
                closes += 1
        elif ch == in_str:
            in_str = None
    return opens, closes


def _unescape_usd_string(raw: str) -> str:
    """Decode a quoted USDA string literal."""
    s = raw.strip()
    if len(s) >= 6 and ((s.startswith('"""') and s.endswith('"""')) or (s.startswith("'''") and s.endswith("'''"))):
        s = s[3:-3]
    elif len(s) >= 2 and ((s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'"))):
        s = s[1:-1]
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == '\\' and i + 1 < n:
            nxt = s[i + 1]
            mapping = {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', '"': '"', "'": "'"}
            out.append(mapping.get(nxt, nxt))
            i += 2
        else:
            out.append(s[i])
            i += 1
    return ''.join(out)


def _parse_numbers(raw: str) -> list[float]:
    """Parse all numbers from a USDA tuple/matrix/array literal."""
    cleaned = raw.replace('(', ' ').replace(')', ' ').replace('[', ' ').replace(']', ' ').replace(',', ' ')
    parts = cleaned.split()
    return [float(tok) for tok in parts]


def _parse_int_array(raw: str) -> list[int]:
    """Parse an integer array from USDA syntax."""
    cleaned = raw.strip()
    if cleaned.startswith('[') and cleaned.endswith(']'):
        cleaned = cleaned[1:-1]
    cleaned = cleaned.replace(',', ' ').strip()
    if not cleaned:
        return []
    return [int(tok) for tok in cleaned.split()]


def _parse_string_array(raw: str) -> list[str]:
    """Parse a JSON-compatible string/token array from USDA syntax."""
    cleaned = raw.strip()
    if not cleaned or cleaned == '[]':
        return []
    # Remove trailing commas before ']'
    cleaned = re.sub(r',\s*\]$', ']', cleaned)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return [str(v) for v in parsed]
    except json.JSONDecodeError:
        pass
    inner = cleaned[1:-1] if cleaned.startswith('[') and cleaned.endswith(']') else cleaned
    return [_unescape_usd_string(tok) for tok in inner.split(',') if tok.strip()]


def _parse_rel_targets(raw: str) -> list[str]:
    """Parse relationship target paths from </a/b>, [</a/b>, </c/d>], [], or None."""
    cleaned = raw.strip()
    if not cleaned or cleaned in ('None', '[]'):
        return []
    if cleaned.startswith('[') and cleaned.endswith(']'):
        cleaned = cleaned[1:-1]
    targets = []
    for item in cleaned.split(','):
        tok = item.strip()
        if not tok or tok == 'None':
            continue
        if tok.startswith('<') and tok.endswith('>'):
            tok = tok[1:-1].strip()
        if tok and tok != 'None':
            targets.append(tok)
    return targets


def _parse_attr_value(value_type: str, raw: str) -> Any:
    """Parse a typed USDA attribute value into Python/NumPy primitives."""
    s = raw.strip()
    if value_type.endswith('[]'):
        base = value_type[:-2]
        if base in ('token', 'string'):
            return _parse_string_array(s)
        if base in ('int', 'uint'):
            return _parse_int_array(s)
        nums = _parse_numbers(s)
        if any(base.endswith(d) or f'{d}f' in base or f'{d}d' in base or f'{d}h' in base for d in ('3',)):
            if len(nums) % 3 != 0:
                raise ValueError(f'Invalid {value_type} array length')
            return np.array(nums, dtype=np.float64).reshape(-1, 3)
        if any(base.endswith(d) or f'{d}f' in base or f'{d}d' in base or f'{d}h' in base for d in ('2',)):
            if len(nums) % 2 != 0:
                raise ValueError(f'Invalid {value_type} array length')
            return np.array(nums, dtype=np.float64).reshape(-1, 2)
        return nums
    if value_type == 'bool':
        low = s.lower()
        if low in ('true', '1'):
            return True
        if low in ('false', '0'):
            return False
        raise ValueError(f'Invalid USDA bool value: {raw!r}')
    if value_type in ('int', 'uint'):
        return int(s)
    if value_type in ('float', 'double', 'half'):
        return float(s)
    if value_type in ('string', 'token'):
        return _unescape_usd_string(s)
    if value_type.startswith('quat'):
        nums = _parse_numbers(s)
        if len(nums) != 4:
            raise ValueError(f'Invalid {value_type} value: {raw!r}')
        return tuple(nums)  # (w, x, y, z) in USDA convention
    if value_type.startswith('matrix4'):
        nums = _parse_numbers(s)
        if len(nums) != 16:
            raise ValueError(f'Invalid {value_type} value: {raw!r}')
        return nums
    if any(tok in value_type for tok in ('2', '3', '4')):
        return _parse_numbers(s)
    return _unescape_usd_string(s)


_DEF_RE = re.compile(r'^def\s+(?:(\w+)\s+)?"([^"]+)"$')
_ATTR_RE = re.compile(r'^(?:custom\s+)?(?:uniform\s+)?(\w+(?:\[\])?)\s+([A-Za-z_][\w.:-]*)$')


def parse_usda(text: str) -> dict[str, Any]:
    """Parse a self-contained ASCII #usda 1.0 layer into header metadata and prim hierarchy."""
    validate_usda_text(text)
    cleaned = _strip_block_comments(text)
    raw_lines = cleaned.splitlines()

    # Preprocess: strip inline comments and collapse multiline [...] arrays.
    lines: list[str] = []
    in_array = False
    bracket_depth = 0
    buf = ''
    for raw_line in raw_lines:
        line = _strip_line_comment(raw_line).strip()
        if not line:
            continue
        if in_array:
            buf += ' ' + line
            opens, closes = _count_brackets_outside_strings(line)
            bracket_depth += opens - closes
            if bracket_depth <= 0:
                lines.append(buf)
                buf = ''
                in_array = False
                bracket_depth = 0
            continue
        eq = _find_top_level_equals(line)
        if eq != -1:
            rhs = line[eq + 1:].strip()
            opens, closes = _count_brackets_outside_strings(rhs)
            if opens > closes:
                in_array = True
                bracket_depth = opens - closes
                buf = line
                continue
        lines.append(line)
    if in_array:
        raise ValueError('Unterminated array in USDA layer')

    header: dict[str, Any] = {}
    prims: dict[str, dict[str, Any]] = {}
    prim_order: list[str] = []

    # Stack frames: ('header',), ('prim_meta', path), ('prim_body', path), ('skip_dict',), ('skip_meta',)
    stack: list[tuple[str, str]] = []
    pending_prim_path: str | None = None
    in_root = True

    def current_prim_parent() -> str:
        for kind, path in reversed(stack):
            if kind == 'prim_body':
                return path
        return ''

    def record_prim_meta(path: str, lhs: str, rhs: str) -> None:
        prim = prims[path]
        if lhs in ('prepend apiSchemas', 'append apiSchemas', 'apiSchemas'):
            items = _parse_string_array(rhs)
            existing = prim['apiSchemas']
            for item in items:
                if item not in existing:
                    existing.append(item)
        elif lhs == 'active':
            prim['meta']['active'] = rhs.lower() in ('true', '1')
        else:
            prim['meta'][lhs] = rhs

    def record_prim_body_assignment(path: str, lhs: str, rhs: str) -> None:
        prim = prims[path]
        if lhs.startswith('rel '):
            rel_name = lhs[4:].strip()
            prim['rels'][rel_name] = _parse_rel_targets(rhs)
            return
        match = _ATTR_RE.match(lhs)
        if not match:
            return
        value_type, attr_name = match.group(1), match.group(2)
        if attr_name.endswith('.connect'):
            prim['connections'][attr_name[:-8]] = _parse_rel_targets(rhs)
            return
        prim['attrs'][attr_name] = {
            'type': value_type,
            'value': _parse_attr_value(value_type, rhs),
        }

    for line in lines:
        if line.startswith('#usda'):
            continue

        # Handle closing braces/parens first.
        if line == '}':
            if not stack:
                raise ValueError('Unexpected "}" in USDA layer')
            stack.pop()
            continue
        if line == ')':
            if not stack:
                raise ValueError('Unexpected ")" in USDA layer')
            stack.pop()
            continue

        top_kind = stack[-1][0] if stack else ''

        # Skip nested dictionaries (e.g. customData = { ... }) or attribute metadata blocks.
        if top_kind in ('skip_dict', 'skip_meta'):
            if line.endswith('{'):
                stack.append(('skip_dict', ''))
            elif line.endswith('('):
                stack.append(('skip_meta', ''))
            continue

        # Header metadata block right after #usda 1.0
        if in_root and not stack and line == '(':
            stack.append(('header', ''))
            continue
        if top_kind == 'header':
            eq = _find_top_level_equals(line)
            if eq != -1:
                lhs = line[:eq].strip()
                rhs = line[eq + 1:].strip()
                if rhs.endswith('{'):
                    stack.append(('skip_dict', ''))
                elif lhs == 'defaultPrim':
                    header['defaultPrim'] = _unescape_usd_string(rhs)
                elif lhs == 'upAxis':
                    header['upAxis'] = _unescape_usd_string(rhs)
                elif lhs == 'metersPerUnit':
                    header['metersPerUnit'] = float(rhs)
                elif lhs == 'doc':
                    header['doc'] = _unescape_usd_string(rhs)
                else:
                    header[lhs] = rhs
            continue

        # Prim metadata block
        if top_kind == 'prim_meta':
            path = stack[-1][1]
            eq = _find_top_level_equals(line)
            if eq != -1:
                lhs = line[:eq].strip()
                rhs = line[eq + 1:].strip()
                if rhs.endswith('{'):
                    stack.append(('skip_dict', ''))
                else:
                    record_prim_meta(path, lhs, rhs)
            continue

        # Open pending prim body or metadata
        if pending_prim_path is not None:
            if line == '(':
                stack.append(('prim_meta', pending_prim_path))
                continue
            if line == '{':
                stack.append(('prim_body', pending_prim_path))
                pending_prim_path = None
                continue

        # Check for new prim definition: def [Type] "Name" [(|{]
        if line.startswith('def '):
            in_root = False
            trailing = ''
            head = line
            if head.endswith('(') or head.endswith('{'):
                trailing = head[-1]
                head = head[:-1].strip()
            match = _DEF_RE.match(head)
            if not match:
                raise ValueError(f'Unsupported prim declaration: {line}')
            prim_type = match.group(1) or ''
            prim_name = match.group(2)
            parent = current_prim_parent()
            path = f'{parent}/{prim_name}' if parent else f'/{prim_name}'
            prims[path] = {
                'path': path,
                'name': prim_name,
                'type': prim_type,
                'parent': parent,
                'apiSchemas': [],
                'meta': {},
                'attrs': {},
                'rels': {},
                'connections': {},
            }
            prim_order.append(path)
            if trailing == '(':
                pending_prim_path = path
                stack.append(('prim_meta', path))
            elif trailing == '{':
                pending_prim_path = None
                stack.append(('prim_body', path))
            else:
                pending_prim_path = path
            continue

        # Inside a prim body: attribute or relationship assignment
        if top_kind == 'prim_body':
            path = stack[-1][1]
            eq = _find_top_level_equals(line)
            if eq != -1:
                lhs = line[:eq].strip()
                rhs = line[eq + 1:].strip()
                opens_meta = False
                if rhs.endswith('(') and not rhs.endswith('()'):
                    # Value metadata block, e.g. normal3f[] normals = [...] (
                    rhs = rhs[:-1].strip()
                    opens_meta = True
                if rhs.endswith('{'):
                    stack.append(('skip_dict', ''))
                else:
                    record_prim_body_assignment(path, lhs, rhs)
                    if opens_meta:
                        stack.append(('skip_meta', ''))
            continue

    return {'header': header, 'prims': prims, 'order': prim_order}


def _prim_local_matrix(prim: dict[str, Any]) -> np.ndarray:
    """Compute the 4x4 column-vector local transform matrix for a parsed USD prim."""
    attrs = prim['attrs']
    order_entry = attrs.get('xformOpOrder')
    mat = np.eye(4, dtype=np.float64)

    def apply_op(op_name: str, invert: bool) -> None:
        nonlocal mat
        entry = attrs.get(op_name)
        if entry is None:
            return
        val = entry['value']
        op = np.eye(4, dtype=np.float64)
        if op_name == 'xformOp:transform' and len(val) == 16:
            # USD row-major -> transpose for column-vector convention.
            op = np.array(val, dtype=np.float64).reshape(4, 4).T
        elif op_name in ('xformOp:translate', 'xformOp:translate:pivot'):
            op[:3, 3] = [float(val[0]), float(val[1]), float(val[2])]
        elif op_name == 'xformOp:scale':
            if isinstance(val, (list, tuple)):
                op[0, 0], op[1, 1], op[2, 2] = float(val[0]), float(val[1]), float(val[2])
            else:
                s = float(val)
                op[0, 0] = op[1, 1] = op[2, 2] = s
        elif op_name == 'xformOp:rotateXYZ':
            op[:3, :3] = _euler_xyz_usd_to_mat3(val)
        elif op_name == 'xformOp:rotateX':
            op[:3, :3] = _euler_xyz_usd_to_mat3([float(val), 0.0, 0.0])
        elif op_name == 'xformOp:rotateY':
            op[:3, :3] = _euler_xyz_usd_to_mat3([0.0, float(val), 0.0])
        elif op_name == 'xformOp:rotateZ':
            op[:3, :3] = _euler_xyz_usd_to_mat3([0.0, 0.0, float(val)])
        elif op_name == 'xformOp:orient':
            op[:3, :3] = _quat_to_mat3(tuple(val))
        else:
            return
        if invert:
            op = np.linalg.inv(op)
        mat = mat @ op

    if order_entry is not None:
        for raw_op in order_entry['value']:
            inv = raw_op.startswith('!invert!')
            apply_op(raw_op[8:] if inv else raw_op, inv)
        return mat

    # Fallback when xformOpOrder is omitted.
    for fallback_op in ('xformOp:translate', 'xformOp:rotateXYZ', 'xformOp:orient', 'xformOp:scale'):
        if fallback_op in attrs:
            apply_op(fallback_op, False)
    return mat


def _world_matrix(prims: dict[str, dict[str, Any]], path: str) -> np.ndarray:
    """Compute cumulative 4x4 local-to-world transform for a prim path."""
    chain: list[dict[str, Any]] = []
    curr = path
    while curr and curr in prims:
        chain.append(prims[curr])
        curr = prims[curr]['parent']
    mat = np.eye(4, dtype=np.float64)
    for prim in reversed(chain):
        mat = mat @ _prim_local_matrix(prim)
    return mat


def _triangulate_mesh_prim(prim: dict[str, Any], world_mat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Extract world-space vertices (metres) and triangles from a Mesh prim."""
    attrs = prim['attrs']
    if 'points' not in attrs or 'faceVertexCounts' not in attrs or 'faceVertexIndices' not in attrs:
        raise ValueError(f'Mesh {prim["name"]} is missing points or face topology')
    pts = np.asarray(attrs['points']['value'], dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3 or len(pts) == 0:
        raise ValueError(f'Mesh {prim["name"]} has invalid points')
    if not np.isfinite(pts).all():
        raise ValueError(f'Nonfinite coordinates in {prim["name"]}')
    counts = attrs['faceVertexCounts']['value']
    indices = attrs['faceVertexIndices']['value']
    if sum(counts) != len(indices):
        raise ValueError(f'Mesh {prim["name"]} faceVertexCounts and faceVertexIndices mismatch')

    tris: list[list[int]] = []
    offset = 0
    n_verts = len(pts)
    for count in counts:
        if count < 3:
            offset += count
            continue
        face = indices[offset:offset + count]
        offset += count
        for idx in face:
            if idx < 0 or idx >= n_verts:
                raise ValueError(f'Mesh {prim["name"]} has out-of-range vertex index {idx}')
        for k in range(1, count - 1):
            tris.append([face[0], face[k], face[k + 1]])

    world_pts = (pts @ world_mat[:3, :3].T) + world_mat[:3, 3]
    tri_arr = np.asarray(tris, dtype=np.int64) if tris else np.zeros((0, 3), dtype=np.int64)
    if np.linalg.det(world_mat[:3, :3]) < 0 and len(tri_arr):
        tri_arr = tri_arr[:, [0, 2, 1]]
    return world_pts, tri_arr


def read_robot(source: str | Path | dict[str, Any]) -> dict[str, Any]:
    """Read and validate a self-contained robot USD into the millimetre/Z-up probe protocol.

    Args:
        source: Path to a .usda file, raw #usda 1.0 text, or a dict returned by parse_usda().

    Returns:
        Dict with keys `assembly`, `nodes`, `meshes` (metres, world-transformed), and optional `controls`.
    """
    if isinstance(source, dict) and 'header' in source and 'prims' in source:
        parsed = source
    elif isinstance(source, Path):
        parsed = parse_usda(source.read_text(encoding='utf-8'))
    elif isinstance(source, str):
        if source.startswith('#usda 1.0'):
            parsed = parse_usda(source)
        else:
            parsed = parse_usda(Path(source).read_text(encoding='utf-8'))
    else:
        raise TypeError('read_robot expects a Path, USDA string, or parsed stage dict')

    header = parsed['header']
    prims = parsed['prims']
    if header.get('upAxis') != 'Z' or header.get('metersPerUnit') != 1:
        raise ValueError('Publish robot USD in metres with Z up')

    default_prim = header.get('defaultPrim')
    root_path = f'/{default_prim}' if default_prim else ''
    root = prims.get(root_path)
    if not root or 'IsaacRobotAPI' not in root['apiSchemas']:
        raise ValueError('USD default prim requires IsaacRobotAPI')

    def attr_value(prim: dict[str, Any], name: str, fallback: Any = None) -> Any:
        entry = prim['attrs'].get(name)
        return fallback if entry is None else entry['value']

    mesh_prims = sorted(
        (prim for prim in prims.values() if prim['type'] == 'Mesh'),
        key=lambda prim: prim['path'],
    )
    mesh_paths = {prim['path'] for prim in mesh_prims}
    link_paths = root['rels'].get('isaac:physics:robotLinks', [])
    joint_paths = root['rels'].get('isaac:physics:robotJoints', [])

    if not link_paths or len(link_paths) != len(mesh_prims) or set(link_paths) != mesh_paths:
        raise ValueError('Isaac robotLinks must include each physical mesh exactly once')

    all_joint_paths = {prim['path'] for prim in prims.values() if re.match(r'^Physics.*Joint$', prim['type'])}
    if len(joint_paths) != len(all_joint_paths) or set(joint_paths) != all_joint_paths:
        raise ValueError('Isaac robotJoints must include every physics joint exactly once')

    names = {path: prims[path]['name'] for path in link_paths}
    world_matrices = {path: _world_matrix(prims, path) for path in link_paths}

    for path in link_paths:
        prim = prims[path]
        schemas = prim['apiSchemas']
        if not all(s in schemas for s in ('IsaacLinkAPI', 'PhysicsRigidBodyAPI', 'PhysicsCollisionAPI')):
            raise ValueError('Each robot link needs IsaacLinkAPI, rigid body and collision schemas')
        if (
            not attr_value(prim, 'physics:rigidBodyEnabled', True)
            or not attr_value(prim, 'physics:collisionEnabled', True)
            or attr_value(prim, 'physics:kinematicEnabled', False)
        ):
            raise ValueError('Robot links require enabled dynamic rigid bodies and collisions')

    connections: list[dict[str, Any]] = []
    for path in joint_paths:
        prim = prims[path]
        kind = JOINT_TYPE_TO_KIND.get(prim['type'])
        if not kind or 'IsaacJointAPI' not in prim['apiSchemas']:
            raise ValueError('Supported robot joints are fixed, revolute and prismatic with IsaacJointAPI')
        parents = prim['rels'].get('physics:body0', [])
        children = prim['rels'].get('physics:body1', [])
        if len(parents) != 1 or len(children) != 1 or parents[0] not in names or children[0] not in names:
            raise ValueError('Joint body0 and body1 must each target one robot link')
        if attr_value(prim, 'physics:jointEnabled', True) is False:
            raise ValueError('Disabled joints cannot describe required physical connections')

        connection: dict[str, Any] = {
            'id': prim['name'],
            'parent': names[parents[0]],
            'child': names[children[0]],
            'kind': kind,
        }
        frames = []
        for idx, body_path in enumerate((parents[0], children[0])):
            mat = world_matrices[body_path]
            pos = attr_value(prim, f'physics:localPos{idx}', [0.0, 0.0, 0.0])
            rot = attr_value(prim, f'physics:localRot{idx}', (1.0, 0.0, 0.0, 0.0))
            if len(pos) != 3 or len(rot) != 4:
                raise ValueError('Joint frames must be finite')
            pos_arr = np.asarray(pos, dtype=np.float64)
            rot_arr = np.asarray(rot, dtype=np.float64)
            if not (np.isfinite(mat).all() and np.isfinite(pos_arr).all() and np.isfinite(rot_arr).all()):
                raise ValueError('Joint frames must be finite')
            qlen = float(np.linalg.norm(rot_arr))
            if not math.isfinite(qlen) or abs(qlen - 1.0) > 1e-5:
                raise ValueError('Joint frame rotations must be unit quaternions')
            world_pos = mat[:3, :3] @ pos_arr + mat[:3, 3]
            frames.append((world_pos, mat[:3, :3], tuple(float(v) for v in rot_arr)))

        if float(np.linalg.norm(frames[0][0] - frames[1][0])) > 1e-6:
            raise ValueError('Joint body frames must meet at the saved rest pose')

        if kind == 'fixed':
            for basis in (AXIS_VECTORS['X'], AXIS_VECTORS['Y'], AXIS_VECTORS['Z']):
                dirs = []
                for _, rot_mat, quat in frames:
                    d = rot_mat @ _quat_rotate_vec(quat, basis)
                    norm = float(np.linalg.norm(d))
                    if norm < 1e-9:
                        raise ValueError('Joint frame transform is singular')
                    dirs.append(d / norm)
                if float(np.linalg.norm(dirs[0] - dirs[1])) > 1e-5:
                    raise ValueError('Fixed joint body frame rotations must agree at the saved rest pose')

            retainer = attr_value(prim, 'rumi:retainer')
            if retainer is not None:
                if retainer not in VALID_RETAINERS:
                    raise ValueError(f'Unsupported retainer kind: {retainer}')
                connection['retainer'] = retainer

            # Recover optional retainer axis (from physics:axis + localRot0 or fallback rumi:retainerAxis).
            axis_name = attr_value(prim, 'physics:axis')
            retainer_axis = attr_value(prim, 'rumi:retainerAxis')
            if axis_name is not None:
                if axis_name not in AXIS_VECTORS:
                    raise ValueError('Joint axis must be X, Y or Z')
                world_axis = frames[0][1] @ _quat_rotate_vec(frames[0][2], AXIS_VECTORS[axis_name])
                norm = float(np.linalg.norm(world_axis))
                if norm < 1e-9:
                    raise ValueError('Joint axis must be nonzero')
                connection['axis'] = [float(v) for v in (world_axis / norm)]
                if float(np.linalg.norm(frames[0][0])) > 1e-9:
                    connection['pivot'] = [float(v * 1000.0) for v in frames[0][0]]
            elif retainer_axis is not None:
                vec = np.asarray(retainer_axis, dtype=np.float64)
                norm = float(np.linalg.norm(vec))
                if vec.shape != (3,) or not np.isfinite(vec).all() or norm < 1e-9:
                    raise ValueError('Retainer axis must be a finite nonzero 3D vector')
                connection['axis'] = [float(v) for v in (vec / norm)]
                if float(np.linalg.norm(frames[0][0])) > 1e-9:
                    connection['pivot'] = [float(v * 1000.0) for v in frames[0][0]]
            elif retainer in ('bayonet', 'threaded'):
                raise ValueError(f'Fixed joint {prim["name"]} with retainer={retainer!r} requires a lock axis')
        else:
            axis_name = attr_value(prim, 'physics:axis', 'X')
            if axis_name not in AXIS_VECTORS:
                raise ValueError('Joint axis must be X, Y or Z')
            base_axis = AXIS_VECTORS[axis_name]
            axes = []
            for _, rot_mat, quat in frames:
                d = rot_mat @ _quat_rotate_vec(quat, base_axis)
                norm = float(np.linalg.norm(d))
                if norm < 1e-9:
                    raise ValueError('Joint frame transform is singular')
                axes.append(d / norm)
            if float(np.linalg.norm(axes[0] - axes[1])) > 1e-5:
                raise ValueError('Joint body frame axes must agree at the saved rest pose')
            scale = 1000.0 if kind == 'prismatic' else 1.0
            lower = attr_value(prim, 'physics:lowerLimit')
            upper = attr_value(prim, 'physics:upperLimit')
            if lower is None or upper is None or not (math.isfinite(float(lower)) and math.isfinite(float(upper))):
                raise ValueError('Moving joints require finite lower and upper limits')
            connection['axis'] = [float(v) for v in axes[0]]
            connection['pivot'] = [float(v * 1000.0) for v in frames[0][0]]
            connection['range'] = [float(lower) * scale, float(upper) * scale]
            control = attr_value(prim, 'rumi:control')
            if control is not None:
                connection['control'] = control

        connections.append(connection)

    manufacturing: dict[str, Any] = {
        'mode': attr_value(root, 'rumi:manufacturingMode', 'print-in-place'),
    }
    steps_raw = attr_value(root, 'rumi:disassembly')
    if steps_raw is not None:
        manufacturing['steps'] = json.loads(steps_raw)

    sequences_raw = attr_value(root, 'rumi:sequences', '[]')
    sequences = json.loads(sequences_raw) if isinstance(sequences_raw, str) else sequences_raw

    controls_raw = attr_value(root, 'rumi:motionControls')
    controls = json.loads(controls_raw) if isinstance(controls_raw, str) else None

    meshes_out = []
    for prim in mesh_prims:
        world_pts, tris = _triangulate_mesh_prim(prim, world_matrices[prim['path']])
        meshes_out.append({
            'name': prim['name'],
            'path': prim['path'],
            'points': world_pts,
            'triangles': tris,
        })

    assembly = {
        'version': 1,
        'root': names[link_paths[0]],
        'parts': [{'id': names[p], 'mesh': names[p]} for p in link_paths],
        'connections': connections,
        'sequences': sequences,
        'manufacturing': manufacturing,
    }
    nodes = [{'name': prim['name'], 'mesh': idx} for idx, prim in enumerate(mesh_prims)]
    result: dict[str, Any] = {'assembly': assembly, 'nodes': nodes, 'meshes': meshes_out}
    if controls is not None:
        result['controls'] = controls
    return result
