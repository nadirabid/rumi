"""Validate immutable USD/STL snapshots and optional companion OpenCASCADE B-Rep solids.

Preserves the exact CLI and JSON schema of blender/validate.py (`version: 1, status, checks,
dimensions, settings, printReady: False, robot, robotError`) plus `mechanicsOutput` for Bullet,
upgrading to exact B-Rep validity, exact surface-to-surface clearance, and per-part print-orientation
overhang and bed-contact analysis when companion `.brep` files are available.
"""
from __future__ import annotations

import copy
import json
import math
import runpy
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.dont_write_bytecode = True
_HERE = Path(__file__).resolve().parent
_robot_usd = runpy.run_path(str(_HERE / 'robot_usd.py'))
_control_geom = runpy.run_path(str(_HERE / 'control_geometry.py'))

read_robot = _robot_usd['read_robot']
require_separate_moving_parts = _robot_usd['require_separate_moving_parts']
make_valid_identifier = _robot_usd['make_valid_identifier']
triangle_intersections = _control_geom['intersections']

MAX_BODIES = 128
MAX_TRIANGLES = 200000
MIN_BED_CONTACT_MM2 = 4.0


# -------------------------------------------------------------------- STL loader

def _read_stl(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Read binary or ASCII STL into (points_mm [N,3], triangles [T,3])."""
    data = path.read_bytes()
    if len(data) < 15:
        raise ValueError('STL file is empty or truncated')

    # Binary STL check: exact size 84 + 50 * n_tris
    if len(data) >= 84:
        n_tris = struct.unpack_from('<I', data, 80)[0]
        if 84 + 50 * n_tris == len(data) and n_tris > 0:
            if n_tris > MAX_TRIANGLES * 2:
                raise ValueError('STL exceeds triangle limit')
            dtype = np.dtype([
                ('normal', '<f4', (3,)),
                ('v0', '<f4', (3,)),
                ('v1', '<f4', (3,)),
                ('v2', '<f4', (3,)),
                ('attr', '<u2'),
            ])
            records = np.frombuffer(data, dtype=dtype, offset=84, count=n_tris)
            pts = np.empty((n_tris * 3, 3), dtype=np.float64)
            pts[0::3] = records['v0']
            pts[1::3] = records['v1']
            pts[2::3] = records['v2']
            tris = np.arange(n_tris * 3, dtype=np.int64).reshape(n_tris, 3)
            return pts, tris

    # ASCII STL fallback
    text = data.decode('utf-8', errors='replace')
    verts: list[tuple[float, float, float]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('vertex '):
            parts = stripped.split()
            if len(parts) == 4:
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
    if len(verts) < 3 or len(verts) % 3 != 0:
        raise ValueError('Invalid STL geometry')
    pts = np.asarray(verts, dtype=np.float64)
    tris = np.arange(len(verts), dtype=np.int64).reshape(-1, 3)
    return pts, tris


# -------------------------------------------------------------------- mesh welding & transforms

def weld_mesh(
    points: np.ndarray,
    triangles: np.ndarray,
    dist: float = 0.001,
) -> tuple[np.ndarray, np.ndarray]:
    """Positional vertex weld within `dist` mm; drops degenerate collapsed triangles."""
    pts = np.asarray(points, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    n = len(pts)
    if n == 0 or len(tris) == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int64)

    inv = 1.0 / dist
    dist2 = dist * dist
    cell_coords = np.floor(pts * inv).astype(np.int64)

    grid: dict[tuple[int, int, int], list[int]] = {}
    remap = np.empty(n, dtype=np.int64)
    unique_pts: list[np.ndarray] = []

    for i in range(n):
        p = pts[i]
        cx, cy, cz = int(cell_coords[i, 0]), int(cell_coords[i, 1]), int(cell_coords[i, 2])
        found = -1
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    bucket = grid.get((cx + dx, cy + dy, cz + dz))
                    if bucket is None:
                        continue
                    for idx in bucket:
                        q = unique_pts[idx]
                        dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
                        if dd <= dist2:
                            found = idx
                            break
                    if found != -1:
                        break
                if found != -1:
                    break
            if found != -1:
                break
        if found == -1:
            found = len(unique_pts)
            unique_pts.append(p)
            grid.setdefault((cx, cy, cz), []).append(found)
        remap[i] = found

    new_pts = np.asarray(unique_pts, dtype=np.float64)
    new_tris = remap[tris]
    valid = (
        (new_tris[:, 0] != new_tris[:, 1])
        & (new_tris[:, 1] != new_tris[:, 2])
        & (new_tris[:, 2] != new_tris[:, 0])
    )
    return new_pts, new_tris[valid]


def _euler_xyz_mat3(rotate_deg: dict[str, float]) -> np.ndarray:
    """Blender/Rumi XYZ Euler rotation matrix (Rz @ Ry @ Rx for column vectors)."""
    rx = math.radians(float(rotate_deg.get('x', 0.0)))
    ry = math.radians(float(rotate_deg.get('y', 0.0)))
    rz = math.radians(float(rotate_deg.get('z', 0.0)))
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return mz @ my @ mx


def _rotation_to_down(normal: np.ndarray) -> np.ndarray:
    """Return a 3x3 rotation matrix mapping unit vector `normal` onto (0, 0, -1)."""
    d = np.asarray(normal, dtype=np.float64)
    d = d / np.linalg.norm(d)
    target = np.array([0.0, 0.0, -1.0], dtype=np.float64)
    dot = float(np.dot(d, target))
    if dot >= 1.0 - 1e-9:
        return np.eye(3, dtype=np.float64)
    if dot <= -1.0 + 1e-9:
        # 180 deg around X maps (0,0,1) -> (0,0,-1)
        return np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]], dtype=np.float64)
    axis = np.cross(d, target)
    s = float(np.linalg.norm(axis))
    axis = axis / s
    c = dot
    vx, vy, vz = axis
    k = np.array([[0.0, -vz, vy], [vz, 0.0, -vx], [-vy, vx, 0.0]], dtype=np.float64)
    return np.eye(3, dtype=np.float64) + s * k + (1.0 - c) * (k @ k)


def _mat3_to_euler_xyz_deg(rot: np.ndarray) -> list[float]:
    """Extract XYZ Euler angles (degrees) from 3x3 rotation matrix R = Rz @ Ry @ Rx."""
    sy = max(-1.0, min(1.0, float(-rot[2, 0])))
    ry = math.asin(sy)
    cy = math.cos(ry)
    if abs(cy) > 1e-7:
        rx = math.atan2(float(rot[2, 1]), float(rot[2, 2]))
        rz = math.atan2(float(rot[1, 0]), float(rot[0, 0]))
    else:
        rx = math.atan2(float(-rot[1, 2]), float(rot[1, 1]))
        rz = 0.0
    return [round(math.degrees(rx), 2) + 0.0, round(math.degrees(ry), 2) + 0.0, round(math.degrees(rz), 2) + 0.0]


# -------------------------------------------------------------------- mesh geometry checks

def _triangle_normals_and_areas(pts: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(tris) == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros(0, dtype=np.float64)
    p0 = pts[tris[:, 0]]
    p1 = pts[tris[:, 1]]
    p2 = pts[tris[:, 2]]
    cross = np.cross(p1 - p0, p2 - p0)
    lengths = np.linalg.norm(cross, axis=1)
    areas = 0.5 * lengths
    safe = np.where(lengths > 1e-18, lengths, 1.0)
    normals = cross / safe[:, None]
    normals[lengths <= 1e-18] = 0.0
    return normals, areas


def _check_part_topology(
    pts: np.ndarray,
    tris: np.ndarray,
    degenerate_threshold: float,
    sharp_degrees: float,
    valid_closed_brep: bool = False,
) -> dict[str, int]:
    """Check manifoldness, winding, degenerates, and sharp edges on one welded mesh."""
    if len(tris) == 0:
        return {
            'non_manifold_edges': 0,
            'inconsistent_winding': 0,
            'degenerate_faces': 0,
            'degenerate_edges': 0,
            'sharp_edges': 0,
        }

    normals, areas = _triangle_normals_and_areas(pts, tris)
    degenerate_faces = int(np.count_nonzero(areas <= degenerate_threshold))

    # Build edge incidence map: undirected (u, v) -> list of (tri_idx, direction +1/-1)
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for tri_idx in range(len(tris)):
        v0, v1, v2 = int(tris[tri_idx, 0]), int(tris[tri_idx, 1]), int(tris[tri_idx, 2])
        for a, b in ((v0, v1), (v1, v2), (v2, v0)):
            if a < b:
                edges.setdefault((a, b), []).append((tri_idx, 1))
            else:
                edges.setdefault((b, a), []).append((tri_idx, -1))

    non_manifold = 0
    inconsistent_winding = 0
    degenerate_edges = 0
    sharp_edges = 0
    sharp_rad = math.radians(sharp_degrees)

    for (u, v), inc in edges.items():
        edge_vec = pts[v] - pts[u]
        edge_len = float(np.linalg.norm(edge_vec))
        if edge_len <= degenerate_threshold:
            degenerate_edges += 1
        if len(inc) != 2:
            # Valid closed B-Rep solids verified by OpenCASCADE (BRepCheck_Analyzer +
            # closed shells + zero free boundary edges) can still emit tangent-seam or
            # per-face tessellation edges with incidence != 2; do not false-flag those.
            if not valid_closed_brep:
                non_manifold += 1
            continue
        (t0, d0), (t1, d1) = inc
        if d0 == d1:
            inconsistent_winding += 1
            continue
        # Signed dihedral fold angle matching Blender bmesh calc_face_angle_signed()
        n0, n1 = normals[t0], normals[t1]
        if np.dot(n0, n0) < 0.5 or np.dot(n1, n1) < 0.5:
            continue
        dot = max(-1.0, min(1.0, float(np.dot(n0, n1))))
        angle = math.acos(dot)
        if angle > sharp_rad:
            # Determine convex vs concave: edge direction in t0 is (u->v if d0==1 else v->u)
            dir_vec = edge_vec if d0 == 1 else -edge_vec
            if float(np.dot(np.cross(n0, n1), dir_vec)) > 0:
                sharp_edges += 1

    # Detect completely inverted closed manifold solid (negative signed volume).
    if non_manifold == 0 and inconsistent_winding == 0:
        ref = pts[0]
        a = pts[tris[:, 0]] - ref
        b = pts[tris[:, 1]] - ref
        c = pts[tris[:, 2]] - ref
        signed_vol = float(np.sum(np.einsum('ij,ij->i', a, np.cross(b, c))) / 6.0)
        if signed_vol < -1e-9:
            inconsistent_winding = len(edges)

    return {
        'non_manifold_edges': non_manifold,
        'inconsistent_winding': inconsistent_winding,
        'degenerate_faces': degenerate_faces,
        'degenerate_edges': degenerate_edges,
        'sharp_edges': sharp_edges,
    }


def _check_thin_faces(
    pts: np.ndarray,
    tris: np.ndarray,
    min_thickness_mm: float,
) -> int:
    """Count faces with an opposing surface closer than `min_thickness_mm` along -normal."""
    n_tris = len(tris)
    if n_tris < 2 or min_thickness_mm <= 0:
        return 0
    normals, areas = _triangle_normals_and_areas(pts, tris)
    v0 = pts[tris[:, 0]]
    v1 = pts[tris[:, 1]]
    v2 = pts[tris[:, 2]]
    centroids = (v0 + v1 + v2) / 3.0

    # Build a spatial grid over triangle AABBs expanded slightly.
    tri_min = np.minimum(np.minimum(v0, v1), v2)
    tri_max = np.maximum(np.maximum(v0, v1), v2)
    cell = max(min_thickness_mm, 0.5)
    origin = tri_min.min(axis=0)
    cmin = np.floor((tri_min - origin) / cell).astype(np.int64)
    cmax = np.floor((tri_max - origin) / cell).astype(np.int64)
    span = cmax - cmin + 1
    counts = span[:, 0] * span[:, 1] * span[:, 2]

    grid: dict[tuple[int, int, int], list[int]] = {}
    large: list[int] = []
    for idx in range(n_tris):
        if int(counts[idx]) > 64:
            large.append(idx)
            continue
        for cx in range(int(cmin[idx, 0]), int(cmax[idx, 0]) + 1):
            for cy in range(int(cmin[idx, 1]), int(cmax[idx, 1]) + 1):
                for cz in range(int(cmin[idx, 2]), int(cmax[idx, 2]) + 1):
                    grid.setdefault((cx, cy, cz), []).append(idx)

    # Shoot one inward ray per valid triangle from centroid - eps*normal along -normal.
    e1 = v1 - v0
    e2 = v2 - v0
    thin_count = 0
    eps = 1e-4
    t_max = min_thickness_mm
    large_arr = np.asarray(large, dtype=np.int64) if large else None

    for idx in range(n_tris):
        if areas[idx] <= 1e-9:
            continue
        n = normals[idx]
        ray_dir = -n
        ray_org = centroids[idx] + ray_dir * eps
        ray_end = centroids[idx] + ray_dir * t_max
        rmin = np.minimum(ray_org, ray_end)
        rmax = np.maximum(ray_org, ray_end)
        rc0 = np.floor((rmin - origin) / cell).astype(np.int64)
        rc1 = np.floor((rmax - origin) / cell).astype(np.int64)

        cand_set: set[int] = set()
        for cx in range(int(rc0[0]), int(rc1[0]) + 1):
            for cy in range(int(rc0[1]), int(rc1[1]) + 1):
                for cz in range(int(rc0[2]), int(rc1[2]) + 1):
                    bucket = grid.get((cx, cy, cz))
                    if bucket:
                        cand_set.update(bucket)
        if large_arr is not None:
            cand_set.update(large)
        cand_set.discard(idx)
        if not cand_set:
            continue

        cands = np.fromiter(cand_set, dtype=np.int64, count=len(cand_set))
        # Filter to opposing faces whose AABB intersects the ray segment AABB.
        mask = (
            (normals[cands] @ n < -0.5)
            & (tri_max[cands, 0] >= rmin[0]) & (tri_min[cands, 0] <= rmax[0])
            & (tri_max[cands, 1] >= rmin[1]) & (tri_min[cands, 1] <= rmax[1])
            & (tri_max[cands, 2] >= rmin[2]) & (tri_min[cands, 2] <= rmax[2])
        )
        cands = cands[mask]
        if len(cands) == 0:
            continue

        # Exclude triangles sharing a vertex with idx (chamfer/corner edges).
        src_verts = (int(tris[idx, 0]), int(tris[idx, 1]), int(tris[idx, 2]))
        c_tris = tris[cands]
        shared = (
            (c_tris[:, 0] == src_verts[0]) | (c_tris[:, 0] == src_verts[1]) | (c_tris[:, 0] == src_verts[2])
            | (c_tris[:, 1] == src_verts[0]) | (c_tris[:, 1] == src_verts[1]) | (c_tris[:, 1] == src_verts[2])
            | (c_tris[:, 2] == src_verts[0]) | (c_tris[:, 2] == src_verts[1]) | (c_tris[:, 2] == src_verts[2])
        )
        cands = cands[~shared]
        if len(cands) == 0:
            continue

        # Vectorized ray-triangle Möller–Trumbore
        ce1 = e1[cands]
        ce2 = e2[cands]
        h = np.cross(ray_dir, ce2)
        a = np.einsum('ij,ij->i', ce1, h)
        non_par = np.abs(a) > 1e-12
        if not np.any(non_par):
            continue
        cands = cands[non_par]
        ce1, ce2, h, a = ce1[non_par], ce2[non_par], h[non_par], a[non_par]
        f = 1.0 / a
        s = ray_org - v0[cands]
        u = f * np.einsum('ij,ij->i', s, h)
        q = np.cross(s, ce1)
        v = f * (q @ ray_dir)
        t = f * np.einsum('ij,ij->i', ce2, q)
        hit = (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1.0 + 1e-6) & (t > 0.0) & (t < (t_max - eps))
        if np.any(hit):
            thin_count += 1

    return thin_count


def _overhang_metrics(
    pts: np.ndarray,
    tris: np.ndarray,
    overhang_degrees: float,
    bed_tolerance_mm: float = 0.1,
) -> dict[str, Any]:
    """Measure bed contact area, overhangs, and Z height in the current orientation."""
    if len(tris) == 0:
        return {
            'bedContactAreaMm2': 0.0,
            'overhangFaceCount': 0,
            'overhangAreaMm2': 0.0,
            'heightMm': 0.0,
        }
    normals, areas = _triangle_normals_and_areas(pts, tris)
    z_min = float(pts[:, 2].min())
    z_max = float(pts[:, 2].max())
    tri_z_max = np.maximum(np.maximum(pts[tris[:, 0], 2], pts[tris[:, 1], 2]), pts[tris[:, 2], 2])
    on_bed = (tri_z_max <= z_min + bed_tolerance_mm) & (normals[:, 2] <= -0.99)
    bed_area = float(areas[on_bed].sum())

    # Blender Print3D Toolbox convention: overhang if angle(normal, -Z) < (90 - overhangDegrees)
    # <=> normal.z < -sin(radians(overhangDegrees))
    threshold_z = -math.sin(math.radians(overhang_degrees)) - 1e-6
    is_overhang = (~on_bed) & (tri_z_max > z_min + bed_tolerance_mm) & (normals[:, 2] < threshold_z) & (areas > 1e-9)
    return {
        'bedContactAreaMm2': bed_area,
        'overhangFaceCount': int(np.count_nonzero(is_overhang)),
        'overhangAreaMm2': float(areas[is_overhang].sum()),
        'heightMm': float(z_max - z_min),
    }


def _brep_planar_normals(shape: Any, max_faces: int = 8) -> list[np.ndarray]:
    """Extract outward unit normals of the largest planar faces on an OCP TopoDS_Shape."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    wrapped = shape.wrapped if hasattr(shape, 'wrapped') else shape
    candidates: list[tuple[float, np.ndarray]] = []
    exp = TopExp_Explorer(wrapped, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face(exp.Current())
        surf = BRepAdaptor_Surface(face)
        if surf.GetType() == GeomAbs_Plane:
            props = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face, props)
            area = float(props.Mass())
            if area > 1e-3:
                d = surf.Plane().Axis().Direction()
                normal = np.array([d.X(), d.Y(), d.Z()], dtype=np.float64)
                if face.Orientation() == TopAbs_REVERSED:
                    normal = -normal
                norm = float(np.linalg.norm(normal))
                if norm > 1e-9:
                    candidates.append((area, normal / norm))
        exp.Next()

    candidates.sort(key=lambda item: item[0], reverse=True)
    unique: list[np.ndarray] = []
    for _, normal in candidates:
        if all(float(np.dot(normal, prev)) < 0.999 for prev in unique):
            unique.append(normal)
            if len(unique) >= max_faces:
                break
    return unique


def analyze_part_print_orientation(
    pts: np.ndarray,
    tris: np.ndarray,
    overhang_degrees: float = 45.0,
    brep_shape: Any = None,
) -> dict[str, Any]:
    """Find the optimal flat print orientation for one part and report overhangs/bed contact."""
    candidates: list[np.ndarray] = [
        np.array([0.0, 0.0, -1.0]),
        np.array([0.0, 0.0, 1.0]),
        np.array([1.0, 0.0, 0.0]),
        np.array([-1.0, 0.0, 0.0]),
        np.array([0.0, 1.0, 0.0]),
        np.array([0.0, -1.0, 0.0]),
    ]
    if brep_shape is not None:
        for normal in _brep_planar_normals(brep_shape):
            if all(float(np.dot(normal, prev)) < 0.999 for prev in candidates):
                candidates.append(normal)

    best: dict[str, Any] | None = None
    best_score = math.inf

    for down_normal in candidates:
        rot = _rotation_to_down(down_normal)
        rotated = pts @ rot.T
        metrics = _overhang_metrics(rotated, tris, overhang_degrees)
        bed_area = metrics['bedContactAreaMm2']
        overhang_area = metrics['overhangAreaMm2']
        height = metrics['heightMm']
        contact_penalty = 500.0 if bed_area < MIN_BED_CONTACT_MM2 else 0.0
        score = overhang_area * 4.0 - bed_area + height * 0.25 + contact_penalty
        if score < best_score - 1e-6:
            best_score = score
            best = {
                'downNormal': [round(float(v), 4) for v in down_normal],
                'rotationEulerDeg': _mat3_to_euler_xyz_deg(rot),
                'bedContactAreaMm2': round(bed_area, 2),
                'overhangFaceCount': metrics['overhangFaceCount'],
                'overhangAreaMm2': round(overhang_area, 2),
                'heightMm': round(height, 2),
            }

    assert best is not None
    return best


# -------------------------------------------------------------------- clearance checks

def _point_to_triangles_min_dist2(point: np.ndarray, v0: np.ndarray, v1: np.ndarray, v2: np.ndarray) -> float:
    """Vectorized exact squared Euclidean distance from one 3D point to M triangles (Ericson)."""
    ab = v1 - v0
    ac = v2 - v0
    ap = point - v0

    d1 = np.einsum('ij,ij->i', ab, ap)
    d2 = np.einsum('ij,ij->i', ac, ap)

    bp = point - v1
    d3 = np.einsum('ij,ij->i', ab, bp)
    d4 = np.einsum('ij,ij->i', ac, bp)

    cp = point - v2
    d5 = np.einsum('ij,ij->i', ab, cp)
    d6 = np.einsum('ij,ij->i', ac, cp)

    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4

    closest = np.empty_like(v0)
    assigned = np.zeros(len(v0), dtype=bool)

    # Region A (vertex v0)
    m = (d1 <= 0.0) & (d2 <= 0.0)
    closest[m] = v0[m]
    assigned |= m

    # Region B (vertex v1)
    m = (~assigned) & (d3 >= 0.0) & (d4 <= d3)
    closest[m] = v1[m]
    assigned |= m

    # Region AB (edge v0-v1)
    m = (~assigned) & (vc <= 0.0) & (d1 >= 0.0) & (d3 <= 0.0)
    if np.any(m):
        denom = d1[m] - d3[m]
        v = np.where(np.abs(denom) > 1e-18, d1[m] / np.where(np.abs(denom) > 1e-18, denom, 1.0), 0.0)
        closest[m] = v0[m] + v[:, None] * ab[m]
        assigned |= m

    # Region C (vertex v2)
    m = (~assigned) & (d6 >= 0.0) & (d5 <= d6)
    closest[m] = v2[m]
    assigned |= m

    # Region AC (edge v0-v2)
    m = (~assigned) & (vb <= 0.0) & (d2 >= 0.0) & (d6 <= 0.0)
    if np.any(m):
        denom = d2[m] - d6[m]
        w = np.where(np.abs(denom) > 1e-18, d2[m] / np.where(np.abs(denom) > 1e-18, denom, 1.0), 0.0)
        closest[m] = v0[m] + w[:, None] * ac[m]
        assigned |= m

    # Region BC (edge v1-v2)
    m = (~assigned) & (va <= 0.0) & ((d4 - d3) >= 0.0) & ((d5 - d6) >= 0.0)
    if np.any(m):
        num = d4[m] - d3[m]
        denom = num + (d5[m] - d6[m])
        w = np.where(np.abs(denom) > 1e-18, num / np.where(np.abs(denom) > 1e-18, denom, 1.0), 0.0)
        closest[m] = v1[m] + w[:, None] * (v2[m] - v1[m])
        assigned |= m

    # Face interior
    m = ~assigned
    if np.any(m):
        denom = va[m] + vb[m] + vc[m]
        safe = np.where(np.abs(denom) > 1e-18, denom, 1.0)
        v = vb[m] / safe
        w = vc[m] / safe
        closest[m] = v0[m] + ab[m] * v[:, None] + ac[m] * w[:, None]

    diff = closest - point
    return float(np.min(np.einsum('ij,ij->i', diff, diff)))


def _mesh_pair_distance(
    pts_a: np.ndarray,
    tris_a: np.ndarray,
    pts_b: np.ndarray,
    tris_b: np.ndarray,
    threshold: float,
) -> float | None:
    """Return exact screening distance (< threshold) between two meshes, or None if >= threshold."""
    # 1. Check mesh-mesh triangle overlap first (gap == 0.0).
    combined_pts = np.vstack([pts_a, pts_b])
    offset = len(pts_a)
    combined_tris = np.vstack([tris_a, tris_b + offset])
    # Adjacent topology only within each part; cross-part pairs always have disjoint keys.
    n_a = len(tris_a)
    topo_a = [frozenset((0, int(t[0]), int(t[1]), int(t[2]))) for t in tris_a]
    topo_b = [frozenset((1, int(t[0]), int(t[1]), int(t[2]))) for t in tris_b]
    # Fast cross-part intersection check: keep only cross-part overlapping AABB triangles.
    a_min = pts_a.min(axis=0)
    a_max = pts_a.max(axis=0)
    b_min = pts_b.min(axis=0)
    b_max = pts_b.max(axis=0)
    if (
        a_max[0] >= b_min[0] - 1e-7 and b_max[0] >= a_min[0] - 1e-7
        and a_max[1] >= b_min[1] - 1e-7 and b_max[1] >= a_min[1] - 1e-7
        and a_max[2] >= b_min[2] - 1e-7 and b_max[2] >= a_min[2] - 1e-7
    ):
        # Filter triangles inside overlapping region
        ov_min = np.maximum(a_min, b_min) - 1e-6
        ov_max = np.minimum(a_max, b_max) + 1e-6
        av0, av1, av2 = pts_a[tris_a[:, 0]], pts_a[tris_a[:, 1]], pts_a[tris_a[:, 2]]
        amask = (
            (np.maximum(np.maximum(av0[:, 0], av1[:, 0]), av2[:, 0]) >= ov_min[0])
            & (np.minimum(np.minimum(av0[:, 0], av1[:, 0]), av2[:, 0]) <= ov_max[0])
            & (np.maximum(np.maximum(av0[:, 1], av1[:, 1]), av2[:, 1]) >= ov_min[1])
            & (np.minimum(np.minimum(av0[:, 1], av1[:, 1]), av2[:, 1]) <= ov_max[1])
            & (np.maximum(np.maximum(av0[:, 2], av1[:, 2]), av2[:, 2]) >= ov_min[2])
            & (np.minimum(np.minimum(av0[:, 2], av1[:, 2]), av2[:, 2]) <= ov_max[2])
        )
        bv0, bv1, bv2 = pts_b[tris_b[:, 0]], pts_b[tris_b[:, 1]], pts_b[tris_b[:, 2]]
        bmask = (
            (np.maximum(np.maximum(bv0[:, 0], bv1[:, 0]), bv2[:, 0]) >= ov_min[0])
            & (np.minimum(np.minimum(bv0[:, 0], bv1[:, 0]), bv2[:, 0]) <= ov_max[0])
            & (np.maximum(np.maximum(bv0[:, 1], bv1[:, 1]), bv2[:, 1]) >= ov_min[1])
            & (np.minimum(np.minimum(bv0[:, 1], bv1[:, 1]), bv2[:, 1]) <= ov_max[1])
            & (np.maximum(np.maximum(bv0[:, 2], bv1[:, 2]), bv2[:, 2]) >= ov_min[2])
            & (np.minimum(np.minimum(bv0[:, 2], bv1[:, 2]), bv2[:, 2]) <= ov_max[2])
        )
        if np.any(amask) and np.any(bmask):
            sub_a = tris_a[amask]
            sub_b = tris_b[bmask] + offset
            sub_tris = np.vstack([sub_a, sub_b])
            sub_topo = [frozenset((0,)) for _ in range(len(sub_a))] + [frozenset((1,)) for _ in range(len(sub_b))]
            if triangle_intersections(combined_pts, sub_tris, sub_topo):
                return 0.0

    # 2. Bidirectional vertex-to-surface distance within `threshold`
    best_d2 = threshold * threshold
    found = False

    def reach(src_pts: np.ndarray, dst_pts: np.ndarray, dst_tris: np.ndarray) -> None:
        nonlocal best_d2, found
        dlow = dst_pts.min(axis=0) - threshold
        dhigh = dst_pts.max(axis=0) + threshold
        in_box = (
            (src_pts[:, 0] >= dlow[0]) & (src_pts[:, 0] <= dhigh[0])
            & (src_pts[:, 1] >= dlow[1]) & (src_pts[:, 1] <= dhigh[1])
            & (src_pts[:, 2] >= dlow[2]) & (src_pts[:, 2] <= dhigh[2])
        )
        candidates = src_pts[in_box]
        if len(candidates) == 0:
            return
        dv0 = dst_pts[dst_tris[:, 0]]
        dv1 = dst_pts[dst_tris[:, 1]]
        dv2 = dst_pts[dst_tris[:, 2]]
        dt_min = np.minimum(np.minimum(dv0, dv1), dv2)
        dt_max = np.maximum(np.maximum(dv0, dv1), dv2)
        for p in candidates:
            rad = math.sqrt(best_d2)
            tmask = (
                (dt_max[:, 0] >= p[0] - rad) & (dt_min[:, 0] <= p[0] + rad)
                & (dt_max[:, 1] >= p[1] - rad) & (dt_min[:, 1] <= p[1] + rad)
                & (dt_max[:, 2] >= p[2] - rad) & (dt_min[:, 2] <= p[2] + rad)
            )
            if not np.any(tmask):
                continue
            d2 = _point_to_triangles_min_dist2(p, dv0[tmask], dv1[tmask], dv2[tmask])
            if d2 < best_d2:
                best_d2 = d2
                found = True

    reach(pts_a, pts_b, tris_b)
    reach(pts_b, pts_a, tris_a)
    return math.sqrt(best_d2) if found else None


def measure_clearances(
    bodies: list[dict[str, Any]],
    assembly: dict[str, Any],
    threshold: float,
    brep_shapes: dict[str, Any] | None = None,
) -> list[tuple[float, str, str]]:
    """Return part pairs closer than `threshold` mm as (gap, a, b), nearest first.

    When exact OpenCASCADE B-Rep shapes are available, uses `BRepExtrema_DistShapeShape`
    for exact surface-to-surface clearance (including curved bores) and checks fixed mates
    for volumetric overlap while permitting flush (0.0 mm) or intentional press/snap contacts.
    """
    fixed = {
        frozenset((item['parent'], item['child']))
        for item in assembly.get('connections', ())
        if item.get('kind') == 'fixed'
    }
    use_brep = brep_shapes is not None and all(body['id'] in brep_shapes for body in bodies)

    if use_brep:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps

        boxes = []
        assert brep_shapes is not None
        for body in bodies:
            shape = brep_shapes[body['id']]
            wrapped = shape.wrapped if hasattr(shape, 'wrapped') else shape
            bnd = Bnd_Box()
            BRepBndLib.AddOptimal_s(wrapped, bnd, False, False)
            if bnd.IsVoid():
                boxes.append((body['points'].min(axis=0), body['points'].max(axis=0)))
            else:
                cmin, cmax = bnd.CornerMin(), bnd.CornerMax()
                boxes.append((
                    np.array([float(cmin.X()), float(cmin.Y()), float(cmin.Z())], dtype=np.float64),
                    np.array([float(cmax.X()), float(cmax.Y()), float(cmax.Z())], dtype=np.float64),
                ))
    else:
        boxes = [
            (body['points'].min(axis=0), body['points'].max(axis=0))
            for body in bodies
        ]

    pairs: list[tuple[float, str, str]] = []
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            id_a, id_b = bodies[i]['id'], bodies[j]['id']
            is_fixed = frozenset((id_a, id_b)) in fixed
            sep = np.maximum(0.0, np.maximum(boxes[i][0] - boxes[j][1], boxes[j][0] - boxes[i][1]))
            if float(np.linalg.norm(sep)) >= threshold:
                continue

            if use_brep:
                assert brep_shapes is not None
                shape_a = brep_shapes[id_a]
                shape_b = brep_shapes[id_b]
                sa = shape_a.wrapped if hasattr(shape_a, 'wrapped') else shape_a
                sb = shape_b.wrapped if hasattr(shape_b, 'wrapped') else shape_b
                extrema = BRepExtrema_DistShapeShape(sa, sb)
                extrema.Perform()
                if not extrema.IsDone():
                    raise RuntimeError(f'BRepExtrema_DistShapeShape failed for ({id_a}, {id_b})')
                gap = float(extrema.Value())
                if is_fixed:
                    # Fixed mates may touch flush (0.0 mm) or use intentional tight press/snap fit,
                    # but true volumetric overlap is still a blocking error.
                    if gap <= 1e-4:
                        common = BRepAlgoAPI_Common(sa, sb)
                        common.Build()
                        if common.IsDone():
                            props = GProp_GProps()
                            BRepGProp.VolumeProperties_s(common.Shape(), props)
                            if float(props.Mass()) > 1e-3:
                                pairs.append((0.0, id_a, id_b))
                    continue
                if gap < threshold:
                    pairs.append((gap, id_a, id_b))
            else:
                if is_fixed:
                    continue
                gap_val = _mesh_pair_distance(
                    bodies[i]['points'], bodies[i]['triangles'],
                    bodies[j]['points'], bodies[j]['triangles'],
                    threshold,
                )
                if gap_val is not None and gap_val < threshold:
                    pairs.append((gap_val, id_a, id_b))

    return sorted(pairs)


# -------------------------------------------------------------------- companion B-Rep loader

def _transform_brep_shape(
    shape: Any,
    centre: np.ndarray,
    scale: float,
    rotation: np.ndarray,
    offset: np.ndarray,
) -> Any:
    """Apply the placement transform to an OCP TopoDS_Shape when non-identity."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Pnt, gp_Trsf

    wrapped = shape.wrapped if hasattr(shape, 'wrapped') else shape
    # Placement maps x -> rotation @ ((x - centre) * scale) + offset
    #                 = (rotation @ (scale * x)) + (offset - scale * rotation @ centre)
    trans = offset - (rotation * scale) @ centre
    is_identity = (
        abs(scale - 1.0) < 1e-9
        and np.allclose(rotation, np.eye(3), atol=1e-9)
        and np.allclose(trans, np.zeros(3), atol=1e-9)
    )
    if is_identity:
        return wrapped

    trsf_rigid = gp_Trsf()
    trsf_rigid.SetValues(
        float(rotation[0, 0]), float(rotation[0, 1]), float(rotation[0, 2]), float(trans[0]),
        float(rotation[1, 0]), float(rotation[1, 1]), float(rotation[1, 2]), float(trans[1]),
        float(rotation[2, 0]), float(rotation[2, 1]), float(rotation[2, 2]), float(trans[2]),
    )
    if abs(scale - 1.0) >= 1e-9:
        trsf_scale = gp_Trsf()
        trsf_scale.SetScale(gp_Pnt(0.0, 0.0, 0.0), float(scale))
        trsf_rigid.Multiply(trsf_scale)
    return BRepBuilderAPI_Transform(wrapped, trsf_rigid, True).Shape()


def _load_companion_breps(input_path: Path, part_ids: list[str], brep_dir: str | None = None) -> dict[str, Any] | None:
    """Load per-part OpenCASCADE .brep companions when present next to a revision .usda."""
    parts_dir = Path(brep_dir) if brep_dir else (input_path.parent / 'parts')
    if not parts_dir.is_dir():
        return None
    files = {pid: parts_dir / f'{pid}.brep' for pid in part_ids}
    if not all(path.is_file() and not path.is_symlink() for path in files.values()):
        return None
    try:
        from OCP.BRep import BRep_Builder
        from OCP.BRepTools import BRepTools
        from OCP.TopoDS import TopoDS_Shape
    except ImportError:
        return None

    builder = BRep_Builder()
    loaded: dict[str, Any] = {}
    for pid, path in files.items():
        shape = TopoDS_Shape()
        if not BRepTools.Read_s(shape, str(path), builder):
            return None
        loaded[pid] = shape
    return loaded


def _is_valid_closed_brep(shape: Any) -> bool:
    """Return True iff `shape` is a valid, closed OpenCASCADE B-Rep solid with zero free boundary edges."""
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    wrapped = shape.wrapped if hasattr(shape, 'wrapped') else shape
    if not TopExp_Explorer(wrapped, TopAbs_SOLID).More():
        return False
    if not BRepCheck_Analyzer(wrapped).IsValid():
        return False
    shell_exp = TopExp_Explorer(wrapped, TopAbs_SHELL)
    has_shell = False
    while shell_exp.More():
        has_shell = True
        if not shell_exp.Current().Closed():
            return False
        shell_exp.Next()
    if not has_shell:
        return False
    free_bounds = ShapeAnalysis_FreeBounds(wrapped)
    for wire_comp in (free_bounds.GetOpenWires(), free_bounds.GetClosedWires()):
        if TopExp_Explorer(wire_comp, TopAbs_EDGE).More():
            return False
    return True


def _check_brep_validity(brep_shapes: dict[str, Any]) -> list[str]:
    """Return list of part IDs whose B-Rep solid fails closed solid validation."""
    return [pid for pid, shape in brep_shapes.items() if not _is_valid_closed_brep(shape)]


# -------------------------------------------------------------------- main validation entry

def validate(request: dict[str, Any]) -> dict[str, Any]:
    """Validate evaluated geometry in millimetres without changing project files."""
    stage = request.get('stage', 'all')
    if stage not in ('all', 'assembly', 'geometry', 'fit'):
        raise ValueError('Unknown validation stage')

    input_path = Path(request['input'])
    path_str = str(input_path)
    robot: dict[str, Any] | None = None
    robot_error: str | None = None
    policy_checks: list[dict[str, Any]] = []
    raw_meshes: list[dict[str, Any]] = []

    if path_str.endswith(('.usda', '.usd')):
        try:
            parsed = read_robot(input_path)
            robot = {'assembly': parsed['assembly'], 'nodes': parsed['nodes']}
            if 'controls' in parsed:
                robot['controls'] = parsed['controls']
            request['assembly'] = copy.deepcopy(parsed['assembly'])
            raw_meshes = parsed['meshes']
            try:
                require_separate_moving_parts(parsed['assembly'])
            except ValueError as error:
                policy_checks.append({
                    'code': 'separate_printing_required',
                    'severity': 'error',
                    'count': 1,
                    'message': str(error),
                })
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            robot_error = str(error)
            request.pop('mechanicsOutput', None)
        if stage == 'assembly':
            return {
                'version': 1,
                'status': 'needs_repair' if robot_error or policy_checks else 'passed',
                'checks': policy_checks,
                'dimensions': {'x': 0, 'y': 0, 'z': 0},
                'printReady': False,
                'robot': robot,
                'robotError': robot_error,
            }
        # If robot metadata failed to parse, still attempt to read raw mesh geometry if possible.
        if not raw_meshes:
            parsed_stage = _robot_usd['parse_usda'](input_path.read_text(encoding='utf-8'))
            prims = parsed_stage['prims']
            for prim in sorted((p for p in prims.values() if p['type'] == 'Mesh'), key=lambda p: p['path']):
                mat = _robot_usd['_world_matrix'](prims, prim['path'])
                pts, tris = _robot_usd['_triangulate_mesh_prim'](prim, mat)
                raw_meshes.append({'name': prim['name'], 'points': pts, 'triangles': tris})
        factor = 1000.0
    elif path_str.endswith('.stl'):
        if stage == 'assembly':
            return {
                'version': 1,
                'status': 'passed',
                'checks': [],
                'dimensions': {'x': 0, 'y': 0, 'z': 0},
                'printReady': False,
            }
        pts, tris = _read_stl(input_path)
        raw_meshes = [{'name': 'model', 'points': pts, 'triangles': tris}]
        factor = 1.0
    else:
        raise ValueError('Validation requires USD (.usda/.usd) or STL (.stl)')

    if not raw_meshes:
        raise ValueError('No mesh geometry to validate')

    # Convert to mm and weld per body.
    bodies: list[dict[str, Any]] = []
    total_triangles = 0
    for mesh in raw_meshes:
        pts_mm = np.asarray(mesh['points'], dtype=np.float64) * factor
        tris = np.asarray(mesh['triangles'], dtype=np.int64)
        if not np.isfinite(pts_mm).all():
            raise ValueError(f'Nonfinite coordinates in {mesh["name"]}')
        total_triangles += len(tris)
        bodies.append({'name': mesh['name'], 'id': mesh['name'], 'points': pts_mm, 'triangles': tris})

    # Verify assembly part mapping when mechanicsOutput is requested.
    if 'mechanicsOutput' in request:
        if len(bodies) > MAX_BODIES:
            raise ValueError('Mechanical validation supports at most 128 mesh bodies')
        if total_triangles > MAX_TRIANGLES:
            raise ValueError('Mechanical validation supports at most 200,000 triangles')
        assembly = request['assembly']
        names = {part['mesh']: part['id'] for part in assembly['parts']}
        if len(names) != len(assembly['parts']) or set(names) != {b['name'] for b in bodies}:
            raise ValueError('Assembly part mappings must match every imported mesh exactly')
        for body in bodies:
            body['id'] = names[body['name']]

    # Weld per-part vertices at 0.001 mm (preserving clean manifold topology).
    for body in bodies:
        body['points'], body['triangles'] = weld_mesh(body['points'], body['triangles'], dist=0.001)

    # Compute placement transform matching blender/validate.py exactly.
    all_pts = np.vstack([b['points'] for b in bodies if len(b['points'])])
    if len(all_pts) == 0:
        raise ValueError('No mesh geometry to validate')
    lower = all_pts.min(axis=0)
    upper = all_pts.max(axis=0)
    centre = (lower + upper) / 2.0

    transform = request.get('transform') or {
        'scale': 1.0,
        'rotate': {'x': 0.0, 'y': 0.0, 'z': 0.0},
        'position': {'x': 0.0, 'y': 0.0, 'z': 0.0},
    }
    scale = float(transform['scale'])
    rotation = _euler_xyz_mat3(transform['rotate'])
    position = np.array([float(transform['position'][a]) for a in 'xyz'], dtype=np.float64)

    for body in bodies:
        body['points'] = ((body['points'] - centre) * scale) @ rotation.T

    rotated_all = np.vstack([b['points'] for b in bodies if len(b['points'])])
    low = rotated_all.min(axis=0)
    high = rotated_all.max(axis=0)
    offset = position - np.array([(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0, low[2]], dtype=np.float64)

    for body in bodies:
        body['points'] = body['points'] + offset

    def placed(point: list[float] | np.ndarray) -> list[float]:
        vec = np.asarray(point, dtype=np.float64)
        out = rotation @ ((vec - centre) * scale) + offset
        return [float(v) for v in out]

    def rotate_vec(vec: list[float] | np.ndarray, scale_vec: float = 1.0) -> list[float]:
        out = rotation @ (np.asarray(vec, dtype=np.float64) * scale_vec)
        return [float(v) for v in out]

    # Load optional companion B-Rep solids for exact validity, clearances, and print orientation.
    companion_breps: dict[str, Any] | None = None
    if path_str.endswith(('.usda', '.usd')):
        raw_breps = _load_companion_breps(input_path, [b['id'] for b in bodies], request.get('brepDir'))
        if raw_breps is not None:
            companion_breps = {
                pid: _transform_brep_shape(shape, centre, scale, rotation, offset)
                for pid, shape in raw_breps.items()
            }

    # Write mechanicsOutput JSON for Bullet when requested.
    clearance: tuple[float, list[tuple[float, str, str]]] | None = None
    settings = request.get('settings') or {}
    if 'mechanicsOutput' in request:
        threshold = float(settings.get('minimumClearanceMm', 0.0))
        if threshold > 0 and len(bodies) >= 2:
            clearance = (threshold, measure_clearances(bodies, request['assembly'], threshold, companion_breps))

        assembly_out = json.loads(json.dumps(request['assembly']))
        for connection in assembly_out['connections']:
            if connection['kind'] == 'fixed':
                if 'axis' in connection:
                    connection['axis'] = rotate_vec(connection['axis'])
                if 'pivot' in connection:
                    connection['pivot'] = placed(connection['pivot'])
                continue
            connection['pivot'] = placed(connection['pivot'])
            connection['axis'] = rotate_vec(connection['axis'])
            if connection['kind'] == 'prismatic':
                connection['range'] = [float(value) * scale for value in connection['range']]
        sliders = {item['id'] for item in assembly_out['connections'] if item['kind'] == 'prismatic'}
        for sequence in assembly_out.get('sequences', []):
            for waypoint in sequence['waypoints']:
                for conn_id in waypoint:
                    if conn_id in sliders:
                        waypoint[conn_id] = float(waypoint[conn_id]) * scale
        for step in assembly_out['manufacturing'].get('steps', []):
            if 'path' in step:
                step['path'] = [rotate_vec(point, scale) for point in step['path']]
            if 'actions' in step:
                transformed_actions = []
                for action in step['actions']:
                    act = dict(action)
                    kind = act.get('kind')
                    if kind == 'translate':
                        act['delta'] = rotate_vec(act['delta'], scale)
                    elif kind == 'rotate':
                        act['pivot'] = placed(act['pivot'])
                        act['axis'] = rotate_vec(act['axis'])
                        if 'pitchMm' in act:
                            act['pitchMm'] = float(act['pitchMm']) * scale
                    elif kind == 'snap':
                        act['delta'] = rotate_vec(act['delta'], scale)
                        if 'maxInterferenceMm' in act:
                            act['maxInterferenceMm'] = float(act['maxInterferenceMm']) * scale
                    transformed_actions.append(act)
                step['actions'] = transformed_actions

        mechanics_bodies = [
            {
                'id': body['id'],
                'vertices': body['points'].tolist(),
                'triangles': body['triangles'].tolist(),
            }
            for body in bodies
        ]
        Path(request['mechanicsOutput']).write_text(
            json.dumps({'bodies': mechanics_bodies, 'assembly': assembly_out}, allow_nan=False) + '\n',
            encoding='utf-8',
        )

    # Geometry checks
    checks: list[dict[str, Any]] = []
    print_orientations: dict[str, dict[str, Any]] | None = None

    if stage in ('all', 'geometry'):
        min_thickness = float(settings.get('minimumThicknessMm', 1.0))
        degen_thresh = float(settings.get('degenerateThreshold', 1e-6))
        overhang_deg = float(settings.get('overhangDegrees', 45.0))
        sharp_deg = float(settings.get('sharpDegrees', 160.0))

        non_manifold_total = 0
        winding_total = 0
        degen_faces_total = 0
        degen_edges_total = 0
        sharp_edges_total = 0
        thin_faces_total = 0

        valid_closed_ids: set[str] = set()
        if companion_breps is not None:
            for pid, shape in companion_breps.items():
                if _is_valid_closed_brep(shape):
                    valid_closed_ids.add(pid)

        for body in bodies:
            topo = _check_part_topology(
                body['points'],
                body['triangles'],
                degen_thresh,
                sharp_deg,
                valid_closed_brep=(body['id'] in valid_closed_ids),
            )
            non_manifold_total += topo['non_manifold_edges']
            winding_total += topo['inconsistent_winding']
            degen_faces_total += topo['degenerate_faces']
            degen_edges_total += topo['degenerate_edges']
            sharp_edges_total += topo['sharp_edges']
            thin_faces_total += _check_thin_faces(body['points'], body['triangles'], min_thickness)

        # Intersecting faces: per-body self-intersections + cross-body overlaps, excluding flush
        # non-overlapping fixed mates (gap == 0.0 mm, zero volumetric overlap).
        fixed_pairs = {
            frozenset((item['parent'], item['child']))
            for item in (request.get('assembly') or {}).get('connections', ())
            if item.get('kind') == 'fixed'
        }
        intersecting_face_keys: set[tuple[int, int]] = set()
        body_boxes = [(b['points'].min(axis=0), b['points'].max(axis=0)) for b in bodies]

        for b_idx, body in enumerate(bodies):
            pts_b = body['points']
            tris_b = body['triangles']
            topo_b = [frozenset((int(t[0]), int(t[1]), int(t[2]))) for t in tris_b]
            for ta, tb in triangle_intersections(pts_b, tris_b, topo_b):
                intersecting_face_keys.add((b_idx, ta))
                intersecting_face_keys.add((b_idx, tb))

        for i in range(len(bodies)):
            for j in range(i + 1, len(bodies)):
                lo_i, hi_i = body_boxes[i]
                lo_j, hi_j = body_boxes[j]
                if (
                    hi_i[0] < lo_j[0] - 1e-6 or hi_j[0] < lo_i[0] - 1e-6
                    or hi_i[1] < lo_j[1] - 1e-6 or hi_j[1] < lo_i[1] - 1e-6
                    or hi_i[2] < lo_j[2] - 1e-6 or hi_j[2] < lo_i[2] - 1e-6
                ):
                    continue

                is_fixed = frozenset((bodies[i]['id'], bodies[j]['id'])) in fixed_pairs
                if is_fixed and companion_breps is not None and bodies[i]['id'] in companion_breps and bodies[j]['id'] in companion_breps:
                    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
                    from OCP.BRepGProp import BRepGProp
                    from OCP.GProp import GProp_GProps

                    sa = companion_breps[bodies[i]['id']]
                    sb = companion_breps[bodies[j]['id']]
                    common = BRepAlgoAPI_Common(
                        sa.wrapped if hasattr(sa, 'wrapped') else sa,
                        sb.wrapped if hasattr(sb, 'wrapped') else sb,
                    )
                    common.Build()
                    if common.IsDone():
                        props = GProp_GProps()
                        BRepGProp.VolumeProperties_s(common.Shape(), props)
                        if float(props.Mass()) <= 1e-3:
                            continue

                ov_min = np.maximum(lo_i, lo_j) - 1e-6
                ov_max = np.minimum(hi_i, hi_j) + 1e-6
                pts_a, tris_a = bodies[i]['points'], bodies[i]['triangles']
                pts_b, tris_b = bodies[j]['points'], bodies[j]['triangles']
                av0, av1, av2 = pts_a[tris_a[:, 0]], pts_a[tris_a[:, 1]], pts_a[tris_a[:, 2]]
                amask = (
                    (np.maximum(np.maximum(av0[:, 0], av1[:, 0]), av2[:, 0]) >= ov_min[0])
                    & (np.minimum(np.minimum(av0[:, 0], av1[:, 0]), av2[:, 0]) <= ov_max[0])
                    & (np.maximum(np.maximum(av0[:, 1], av1[:, 1]), av2[:, 1]) >= ov_min[1])
                    & (np.minimum(np.minimum(av0[:, 1], av1[:, 1]), av2[:, 1]) <= ov_max[1])
                    & (np.maximum(np.maximum(av0[:, 2], av1[:, 2]), av2[:, 2]) >= ov_min[2])
                    & (np.minimum(np.minimum(av0[:, 2], av1[:, 2]), av2[:, 2]) <= ov_max[2])
                )
                bv0, bv1, bv2 = pts_b[tris_b[:, 0]], pts_b[tris_b[:, 1]], pts_b[tris_b[:, 2]]
                bmask = (
                    (np.maximum(np.maximum(bv0[:, 0], bv1[:, 0]), bv2[:, 0]) >= ov_min[0])
                    & (np.minimum(np.minimum(bv0[:, 0], bv1[:, 0]), bv2[:, 0]) <= ov_max[0])
                    & (np.maximum(np.maximum(bv0[:, 1], bv1[:, 1]), bv2[:, 1]) >= ov_min[1])
                    & (np.minimum(np.minimum(bv0[:, 1], bv1[:, 1]), bv2[:, 1]) <= ov_max[1])
                    & (np.maximum(np.maximum(bv0[:, 2], bv1[:, 2]), bv2[:, 2]) >= ov_min[2])
                    & (np.minimum(np.minimum(bv0[:, 2], bv1[:, 2]), bv2[:, 2]) <= ov_max[2])
                )
                a_indices = np.nonzero(amask)[0]
                b_indices = np.nonzero(bmask)[0]
                if len(a_indices) == 0 or len(b_indices) == 0:
                    continue
                pair_pts = np.vstack([pts_a, pts_b])
                pair_tris = np.vstack([tris_a[a_indices], tris_b[b_indices] + len(pts_a)])
                n_sub_a = len(a_indices)
                pair_topo = [frozenset((0,)) for _ in range(n_sub_a)] + [frozenset((1,)) for _ in range(len(b_indices))]
                strict = is_fixed and (companion_breps is None)
                for ta, tb in triangle_intersections(pair_pts, pair_tris, pair_topo, strict_interior=strict):
                    if ta < n_sub_a:
                        intersecting_face_keys.add((i, int(a_indices[ta])))
                    else:
                        intersecting_face_keys.add((j, int(b_indices[ta - n_sub_a])))
                    if tb < n_sub_a:
                        intersecting_face_keys.add((i, int(a_indices[tb])))
                    else:
                        intersecting_face_keys.add((j, int(b_indices[tb - n_sub_a])))

        intersecting_faces = len(intersecting_face_keys)

        # Overhangs & per-part print orientation analysis
        mfg_mode = (request.get('assembly') or {}).get('manufacturing', {}).get('mode')
        use_per_part_orient = (mfg_mode == 'separate') or (companion_breps is not None)
        overhang_count = 0
        overhang_details: dict[str, Any] | None = None
        small_contact_parts: list[dict[str, Any]] = []

        if use_per_part_orient:
            print_orientations = {}
            per_part_overhangs: list[dict[str, Any]] = []
            for body in bodies:
                pid = body['id']
                brep_shape = companion_breps.get(pid) if companion_breps else None
                orient = analyze_part_print_orientation(
                    body['points'], body['triangles'], overhang_deg, brep_shape=brep_shape,
                )
                print_orientations[pid] = orient
                overhang_count += orient['overhangFaceCount']
                if orient['overhangFaceCount'] > 0:
                    per_part_overhangs.append({
                        'part': pid,
                        'overhangFaceCount': orient['overhangFaceCount'],
                        'overhangAreaMm2': orient['overhangAreaMm2'],
                        'rotationEulerDeg': orient['rotationEulerDeg'],
                    })
                if orient['bedContactAreaMm2'] < MIN_BED_CONTACT_MM2:
                    small_contact_parts.append({
                        'part': pid,
                        'bedContactAreaMm2': orient['bedContactAreaMm2'],
                        'rotationEulerDeg': orient['rotationEulerDeg'],
                    })
            if per_part_overhangs:
                overhang_details = {'mode': 'print_orientation', 'parts': per_part_overhangs[:8]}
        else:
            for body in bodies:
                metrics = _overhang_metrics(body['points'], body['triangles'], overhang_deg)
                overhang_count += metrics['overhangFaceCount']

        checks.extend([
            {'code': 'non_manifold_edges', 'count': non_manifold_total, 'severity': 'error'},
            {'code': 'inconsistent_winding', 'count': winding_total, 'severity': 'error'},
            {'code': 'intersecting_faces', 'count': intersecting_faces, 'severity': 'error'},
            {'code': 'degenerate_faces', 'count': degen_faces_total, 'severity': 'error'},
            {'code': 'degenerate_edges', 'count': degen_edges_total, 'severity': 'error'},
            {'code': 'distorted_faces', 'count': 0, 'severity': 'warning'},
            {'code': 'thin_faces', 'count': thin_faces_total, 'severity': 'warning'},
            {'code': 'sharp_edges', 'count': sharp_edges_total, 'severity': 'warning'},
            {
                'code': 'overhangs',
                'count': overhang_count,
                'severity': 'warning',
                **({'details': overhang_details} if overhang_details else {}),
            },
        ])

        if small_contact_parts:
            checks.append({
                'code': 'small_bed_contact',
                'count': len(small_contact_parts),
                'severity': 'warning',
                'details': {'minimumBedContactMm2': MIN_BED_CONTACT_MM2, 'parts': small_contact_parts[:8]},
            })

        if companion_breps is not None:
            invalid_solids = _check_brep_validity(companion_breps)
            if invalid_solids:
                checks.append({
                    'code': 'invalid_brep_solid',
                    'count': len(invalid_solids),
                    'severity': 'error',
                    'details': {'parts': invalid_solids[:8]},
                })

    checks.extend(policy_checks)

    if clearance is not None:
        threshold, close = clearance
        checks.append({
            'code': 'insufficient_clearance',
            'count': len(close),
            'severity': 'error',
            'details': {
                'minimumClearanceMm': threshold,
                'pairs': [{'a': a, 'b': b, 'gapMm': round(gap, 4)} for gap, a, b in close[:8]],
            },
        })

    dimensions = {axis: float(high[i] - low[i]) for i, axis in enumerate('xyz')}
    volume = request.get('volume')
    if volume is not None:
        checks.append({
            'code': 'oversized',
            'count': int(any(dimensions[a] > float(volume[a]) for a in 'xyz')),
            'severity': 'error',
        })

    status = (
        'needs_repair'
        if any(c['count'] and c['severity'] == 'error' for c in checks)
        else 'review'
        if any(c['count'] for c in checks)
        else 'passed'
    )
    report: dict[str, Any] = {
        'version': 1,
        'status': status,
        'checks': checks,
        'dimensions': dimensions,
        'settings': request.get('settings'),
        'printReady': False,
        'robot': robot,
        'robotError': robot_error,
    }
    if print_orientations is not None:
        report['printOrientations'] = print_orientations
    return report


def _request_path_from_argv(argv: list[str]) -> str:
    if '--' in argv:
        return argv[argv.index('--') + 1]
    if len(argv) >= 2:
        return argv[1]
    raise SystemExit('Usage: validate.py [--] <request.json>')


if __name__ == '__main__':
    request = json.loads(Path(_request_path_from_argv(sys.argv)).read_text(encoding='utf-8'))
    result = validate(request)
    Path(request['output']).write_text(json.dumps(result, allow_nan=False) + '\n', encoding='utf-8')
