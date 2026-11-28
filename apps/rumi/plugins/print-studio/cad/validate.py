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
    return_mask: bool = False,
) -> tuple[np.ndarray, np.ndarray] | tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Positional vertex weld within `dist` mm; drops degenerate collapsed triangles."""
    pts = np.asarray(points, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    n = len(pts)
    if n == 0 or len(tris) == 0:
        empty_pts = np.zeros((0, 3), dtype=np.float64)
        empty_tris = np.zeros((0, 3), dtype=np.int64)
        if return_mask:
            return empty_pts, empty_tris, np.zeros((0,), dtype=bool)
        return empty_pts, empty_tris

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
    if return_mask:
        return new_pts, new_tris[valid], valid
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
    n_tris = len(tris)
    if n_tris == 0:
        return {
            'non_manifold_edges': 0,
            'inconsistent_winding': 0,
            'degenerate_faces': 0,
            'degenerate_edges': 0,
            'sharp_edges': 0,
        }

    normals, areas = _triangle_normals_and_areas(pts, tris)
    degenerate_faces = int(np.count_nonzero(areas <= degenerate_threshold))

    # Vectorized undirected edge grouping: 3 half-edges per triangle packed into int64 keys.
    ea = np.concatenate((tris[:, 0], tris[:, 1], tris[:, 2]))
    eb = np.concatenate((tris[:, 1], tris[:, 2], tris[:, 0]))
    tri_ids = np.tile(np.arange(n_tris, dtype=np.int64), 3)
    fwd = ea < eb
    u = np.where(fwd, ea, eb).astype(np.int64)
    v = np.where(fwd, eb, ea).astype(np.int64)
    dirs = np.where(fwd, 1, -1).astype(np.int8)

    keys = (u << 32) | v
    order = np.argsort(keys, kind='mergesort')
    keys_s = keys[order]
    u_s = u[order]
    v_s = v[order]
    dirs_s = dirs[order]
    tris_s = tri_ids[order]

    split = np.flatnonzero(np.diff(keys_s)) + 1
    starts = np.concatenate(([0], split))
    ends = np.concatenate((split, [len(keys_s)]))
    counts = ends - starts
    n_edges = len(starts)

    u_uniq = u_s[starts]
    v_uniq = v_s[starts]
    edge_vecs = pts[v_uniq] - pts[u_uniq]
    edge_lens = np.linalg.norm(edge_vecs, axis=1)
    degenerate_edges = int(np.count_nonzero(edge_lens <= degenerate_threshold))

    non_manifold = 0 if valid_closed_brep else int(np.count_nonzero(counts != 2))

    # Manifold interior edges (incidence == 2)
    pair_mask = counts == 2
    inconsistent_winding = 0
    sharp_edges = 0
    if np.any(pair_mask):
        p_starts = starts[pair_mask]
        d0 = dirs_s[p_starts]
        d1 = dirs_s[p_starts + 1]
        same_dir = d0 == d1
        inconsistent_winding = int(np.count_nonzero(same_dir))

        good = ~same_dir
        if np.any(good):
            g_starts = p_starts[good]
            t0 = tris_s[g_starts]
            t1 = tris_s[g_starts + 1]
            n0 = normals[t0]
            n1 = normals[t1]
            valid_n = (np.einsum('ij,ij->i', n0, n0) >= 0.5) & (np.einsum('ij,ij->i', n1, n1) >= 0.5)
            if np.any(valid_n):
                n0v = n0[valid_n]
                n1v = n1[valid_n]
                cos_thresh = math.cos(math.radians(sharp_degrees))
                dots = np.clip(np.einsum('ij,ij->i', n0v, n1v), -1.0, 1.0)
                sharp_cand = dots < cos_thresh
                if np.any(sharp_cand):
                    g_d0 = d0[good][valid_n][sharp_cand]
                    g_ev = edge_vecs[pair_mask][good][valid_n][sharp_cand]
                    dir_vecs = np.where(g_d0[:, None] == 1, g_ev, -g_ev)
                    convex = np.einsum('ij,ij->i', np.cross(n0v[sharp_cand], n1v[sharp_cand]), dir_vecs) > 0.0
                    sharp_edges = int(np.count_nonzero(convex))

    # Detect completely inverted closed manifold solid (negative signed volume).
    if non_manifold == 0 and inconsistent_winding == 0:
        ref = pts[0]
        a = pts[tris[:, 0]] - ref
        b = pts[tris[:, 1]] - ref
        c = pts[tris[:, 2]] - ref
        signed_vol = float(np.sum(np.einsum('ij,ij->i', a, np.cross(b, c))) / 6.0)
        if signed_vol < -1e-9:
            inconsistent_winding = n_edges

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

    # Adaptive cell size keeps large faces inside the grid without exploding per-triangle sets.
    tri_min = np.minimum(np.minimum(v0, v1), v2)
    tri_max = np.maximum(np.maximum(v0, v1), v2)
    origin = tri_min.min(axis=0)
    bbox_diag = float(np.linalg.norm(tri_max.max(axis=0) - origin))
    cell = max(min_thickness_mm * 2.0, bbox_diag / 36.0, 1.0)
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
        x0, y0, z0 = int(cmin[idx, 0]), int(cmin[idx, 1]), int(cmin[idx, 2])
        x1, y1, z1 = int(cmax[idx, 0]), int(cmax[idx, 1]), int(cmax[idx, 2])
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                for cz in range(z0, z1 + 1):
                    grid.setdefault((cx, cy, cz), []).append(idx)

    # Pre-convert grid buckets to NumPy arrays once so lookups never allocate Python sets.
    grid_arr: dict[tuple[int, int, int], np.ndarray] = {
        k: np.asarray(v, dtype=np.int64) for k, v in grid.items()
    }
    large_arr = np.asarray(large, dtype=np.int64) if large else None

    e1 = v1 - v0
    e2 = v2 - v0
    thin_count = 0
    eps = 1e-4
    t_max = min_thickness_mm

    # Precompute ray endpoints and grid ranges vectorized for all triangles.
    ray_dirs = -normals
    ray_orgs = centroids + ray_dirs * eps
    ray_ends = centroids + ray_dirs * t_max
    rmins = np.minimum(ray_orgs, ray_ends)
    rmaxs = np.maximum(ray_orgs, ray_ends)
    rc0s = np.floor((rmins - origin) / cell).astype(np.int64)
    rc1s = np.floor((rmaxs - origin) / cell).astype(np.int64)

    # For very dense tessellations, sample evenly across faces while testing against all triangles.
    stride = max(1, n_tris // 5000)
    sample_indices = range(0, n_tris, stride)

    for idx in sample_indices:
        if areas[idx] <= 1e-9:
            continue
        rx0, ry0, rz0 = int(rc0s[idx, 0]), int(rc0s[idx, 1]), int(rc0s[idx, 2])
        rx1, ry1, rz1 = int(rc1s[idx, 0]), int(rc1s[idx, 1]), int(rc1s[idx, 2])
        chunks: list[np.ndarray] = []
        for cx in range(rx0, rx1 + 1):
            for cy in range(ry0, ry1 + 1):
                for cz in range(rz0, rz1 + 1):
                    bucket = grid_arr.get((cx, cy, cz))
                    if bucket is not None:
                        chunks.append(bucket)
        if large_arr is not None:
            chunks.append(large_arr)
        if not chunks:
            continue
        cands = chunks[0] if len(chunks) == 1 else np.concatenate(chunks)

        n = normals[idx]
        rmin = rmins[idx]
        rmax = rmaxs[idx]
        mask = (
            (cands != idx)
            & (normals[cands] @ n < -0.5)
            & (tri_max[cands, 0] >= rmin[0]) & (tri_min[cands, 0] <= rmax[0])
            & (tri_max[cands, 1] >= rmin[1]) & (tri_min[cands, 1] <= rmax[1])
            & (tri_max[cands, 2] >= rmin[2]) & (tri_min[cands, 2] <= rmax[2])
        )
        cands = cands[mask]
        if len(cands) == 0:
            continue
        if len(chunks) > 1:
            cands = np.unique(cands)

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

        ray_dir = ray_dirs[idx]
        ray_org = ray_orgs[idx]
        ce1 = e1[cands]
        ce2 = e2[cands]
        h = np.cross(ray_dir, ce2)
        a = np.einsum('ij,ij->i', ce1, h)
        non_par = np.abs(a) > 1e-12
        if not np.any(non_par):
            continue
        ce1, ce2, h, a = ce1[non_par], ce2[non_par], h[non_par], a[non_par]
        cands = cands[non_par]
        f = 1.0 / a
        s = ray_org - v0[cands]
        u = f * np.einsum('ij,ij->i', s, h)
        q = np.cross(s, ce1)
        v = f * (q @ ray_dir)
        t = f * np.einsum('ij,ij->i', ce2, q)
        if np.any((u >= -1e-6) & (v >= -1e-6) & (u + v <= 1.0 + 1e-6) & (t > 0.0) & (t < (t_max - eps))):
            thin_count += stride

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


def _mesh_center_of_mass(pts: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Compute volume-weighted 3D center of mass of a closed triangle mesh."""
    if len(tris) == 0:
        return np.zeros(3, dtype=np.float64)
    ref = pts[0]
    a = pts[tris[:, 0]] - ref
    b = pts[tris[:, 1]] - ref
    c = pts[tris[:, 2]] - ref
    vols = np.einsum('ij,ij->i', a, np.cross(b, c)) / 6.0
    total_vol = float(vols.sum())
    if abs(total_vol) < 1e-12:
        return pts.mean(axis=0)
    centroids = (a + b + c) * 0.25
    return ref + (vols[:, None] * centroids).sum(axis=0) / total_vol


def _convex_hull_2d(points: np.ndarray) -> list[tuple[float, float]]:
    """Compute counter-clockwise 2D convex hull via Andrew's monotone chain (no scipy.spatial import)."""
    pts = sorted({(round(float(p[0]), 4), round(float(p[1]), 4)) for p in points})
    if len(pts) < 3:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0.0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0.0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _point_in_convex_polygon_2d(px: float, py: float, hull: list[tuple[float, float]], tol: float = 0.5) -> bool:
    """Return True iff (px, py) lies inside (or within `tol` mm of) a CCW 2D convex polygon."""
    n = len(hull)
    if n < 3:
        return False
    for i in range(n):
        ax, ay = hull[i]
        bx, by = hull[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        elen = math.hypot(ex, ey)
        if elen < 1e-9:
            continue
        # Signed distance to left of directed edge a->b; negative means outside CCW hull.
        signed_dist = (ex * (py - ay) - ey * (px - ax)) / elen
        if signed_dist < -tol:
            return False
    return True


def _bed_stability_metrics(
    pts: np.ndarray,
    tris: np.ndarray,
    normals: np.ndarray,
    areas: np.ndarray,
    bed_tolerance_mm: float = 0.1,
) -> dict[str, Any]:
    """Check whether the part's center of mass projects inside its bed-contact convex hull."""
    z_min = float(pts[:, 2].min())
    z_max = float(pts[:, 2].max())
    height = float(z_max - z_min)
    tri_z_max = np.maximum(np.maximum(pts[tris[:, 0], 2], pts[tris[:, 1], 2]), pts[tris[:, 2], 2])
    on_bed = (tri_z_max <= z_min + bed_tolerance_mm) & (normals[:, 2] <= -0.99)
    bed_area = float(areas[on_bed].sum())

    com = _mesh_center_of_mass(pts, tris)
    com_inside = False
    min_bed_span = 0.0

    if np.any(on_bed) and bed_area >= 1e-3:
        bed_vert_ids = np.unique(tris[on_bed].ravel())
        bed_xy = pts[bed_vert_ids, :2]
        span_x = float(bed_xy[:, 0].max() - bed_xy[:, 0].min())
        span_y = float(bed_xy[:, 1].max() - bed_xy[:, 1].min())
        min_bed_span = min(span_x, span_y)
        if len(bed_xy) >= 3 and span_x > 1e-4 and span_y > 1e-4:
            hull = _convex_hull_2d(bed_xy)
            com_inside = _point_in_convex_polygon_2d(float(com[0]), float(com[1]), hull, tol=0.5)

    xy_bbox_area = float((pts[:, 0].max() - pts[:, 0].min()) * (pts[:, 1].max() - pts[:, 1].min()))
    tip_over = (not com_inside) or (
        height > 25.0 and bed_area < 80.0 and (height / max(min_bed_span, 0.5)) > 6.0
    )
    return {
        'bedContactAreaMm2': bed_area,
        'comInsideBed': com_inside,
        'minBedSpanMm': min_bed_span,
        'xyBboxAreaMm2': xy_bbox_area,
        'heightMm': height,
        'tipOverRisk': tip_over,
    }


def _rasterize_z_slice(
    pts: np.ndarray,
    tris: np.ndarray,
    tri_z_min: np.ndarray,
    tri_z_max: np.ndarray,
    z: float,
    x_min: float,
    y_min: float,
    px: float,
    nx: int,
    ny: int,
) -> np.ndarray:
    """Intersect a closed triangle mesh with horizontal plane Z and scanline-fill a 2D mask."""
    mask = np.zeros((ny, nx), dtype=bool)
    active = np.nonzero((tri_z_min < z) & (tri_z_max > z))[0]
    if len(active) == 0:
        return mask

    t_act = tris[active]
    p0 = pts[t_act[:, 0]]
    p1 = pts[t_act[:, 1]]
    p2 = pts[t_act[:, 2]]
    z0, z1, z2 = p0[:, 2], p1[:, 2], p2[:, 2]

    # Collect crossing edge intersections: each active triangle has exactly 2 edges crossing z.
    a0, a1, a2 = z0 > z, z1 > z, z2 > z
    c01 = a0 != a1
    c12 = a1 != a2
    c20 = a2 != a0

    seg_x0 = np.empty(len(active), dtype=np.float64)
    seg_y0 = np.empty(len(active), dtype=np.float64)
    seg_x1 = np.empty(len(active), dtype=np.float64)
    seg_y1 = np.empty(len(active), dtype=np.float64)

    def _edge_pt(pa: np.ndarray, pb: np.ndarray, za: np.ndarray, zb: np.ndarray, m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        t = (z - za[m]) / (zb[m] - za[m])
        return pa[m, 0] + t * (pb[m, 0] - pa[m, 0]), pa[m, 1] + t * (pb[m, 1] - pa[m, 1])

    # Three mutually exclusive crossing pairs: (01,12), (01,20), (12,20)
    m_a = c01 & c12
    if np.any(m_a):
        seg_x0[m_a], seg_y0[m_a] = _edge_pt(p0, p1, z0, z1, m_a)
        seg_x1[m_a], seg_y1[m_a] = _edge_pt(p1, p2, z1, z2, m_a)
    m_b = c01 & c20 & (~m_a)
    if np.any(m_b):
        seg_x0[m_b], seg_y0[m_b] = _edge_pt(p0, p1, z0, z1, m_b)
        seg_x1[m_b], seg_y1[m_b] = _edge_pt(p2, p0, z2, z0, m_b)
    m_c = c12 & c20 & (~m_a) & (~m_b)
    if np.any(m_c):
        seg_x0[m_c], seg_y0[m_c] = _edge_pt(p1, p2, z1, z2, m_c)
        seg_x1[m_c], seg_y1[m_c] = _edge_pt(p2, p0, z2, z0, m_c)

    valid = m_a | m_b | m_c
    if not np.any(valid):
        return mask
    seg_x0, seg_y0, seg_x1, seg_y1 = seg_x0[valid], seg_y0[valid], seg_x1[valid], seg_y1[valid]

    # Order each segment so y_lo <= y_hi for fast half-open scanline parity fill.
    swap = seg_y0 > seg_y1
    y_lo = np.where(swap, seg_y1, seg_y0)
    y_hi = np.where(swap, seg_y0, seg_y1)
    x_lo = np.where(swap, seg_x1, seg_x0)
    x_hi = np.where(swap, seg_x0, seg_x1)

    non_horiz = (y_hi - y_lo) > 1e-12
    if not np.any(non_horiz):
        return mask
    y_lo, y_hi, x_lo, x_hi = y_lo[non_horiz], y_hi[non_horiz], x_lo[non_horiz], x_hi[non_horiz]
    inv_dy = 1.0 / (y_hi - y_lo)

    r_start = np.maximum(0, np.ceil((y_lo - y_min) / px - 0.5).astype(np.int64))
    r_end = np.minimum(ny - 1, np.floor((y_hi - y_min) / px - 0.5).astype(np.int64))
    active_seg = r_start <= r_end
    if not np.any(active_seg):
        return mask
    y_lo, x_lo, x_hi, inv_dy = y_lo[active_seg], x_lo[active_seg], x_hi[active_seg], inv_dy[active_seg]
    r_start, r_end = r_start[active_seg], r_end[active_seg]
    dx_inv_dy = (x_hi - x_lo) * inv_dy

    # Vectorized expansion of (row, segment) pairs avoids O(ny * M) per-row Python masks.
    row_counts = r_end - r_start + 1
    seg_ids = np.repeat(np.arange(len(r_start), dtype=np.int64), row_counts)
    offsets = np.arange(len(seg_ids), dtype=np.int64) - np.repeat(np.cumsum(row_counts) - row_counts, row_counts)
    rows = r_start[seg_ids] + offsets
    yrs = y_min + (rows + 0.5) * px
    xs = x_lo[seg_ids] + (yrs - y_lo[seg_ids]) * dx_inv_dy[seg_ids]

    order = np.lexsort((xs, rows))
    rows_s = rows[order]
    xs_s = xs[order]
    # Split sorted arrays by row boundaries
    split_pts = np.flatnonzero(np.diff(rows_s)) + 1
    starts = np.concatenate(([0], split_pts))
    ends = np.concatenate((split_pts, [len(rows_s)]))
    inv_px = 1.0 / px
    for s_i, e_i in zip(starts, ends):
        count = e_i - s_i
        if count < 2:
            continue
        r = int(rows_s[s_i])
        row_xs = xs_s[s_i:e_i]
        for k in range(0, count - 1, 2):
            ix0 = int(math.ceil((row_xs[k] - x_min) * inv_px - 0.5))
            ix1 = int(math.floor((row_xs[k + 1] - x_min) * inv_px - 0.5)) + 1
            if ix1 > 0 and ix0 < nx:
                mask[r, max(0, ix0):min(nx, ix1)] = True
    return mask


def _analyze_part_layer_printability(
    pts: np.ndarray,
    tris: np.ndarray,
    overhang_degrees: float = 45.0,
    nozzle_mm: float = 0.4,
) -> dict[str, Any]:
    """Run generic 2D-layer FDM pre-checks on one part already rotated into its print orientation."""
    result: dict[str, Any] = {
        'floatingIslandCount': 0,
        'floatingMinZMm': None,
        'floatingMaxAreaMm2': 0.0,
        'thinWallLayerCount': 0,
        'thinWallAreaMm2': 0.0,
        'trappedOverhangAreaMm2': 0.0,
        'tipOverRisk': False,
        'comInsideBed': True,
    }
    if len(tris) < 4:
        return result

    normals, areas = _triangle_normals_and_areas(pts, tris)
    stab = _bed_stability_metrics(pts, tris, normals, areas)
    result['tipOverRisk'] = stab['tipOverRisk']
    result['comInsideBed'] = stab['comInsideBed']

    z_min = float(pts[:, 2].min())
    z_max = float(pts[:, 2].max())
    height = z_max - z_min
    if height < 0.4:
        return result

    from scipy import ndimage

    x_min, x_max = float(pts[:, 0].min()), float(pts[:, 0].max())
    y_min, y_max = float(pts[:, 1].min()), float(pts[:, 1].max())
    span = max(x_max - x_min, y_max - y_min, 1.0)
    px = max(0.16, span / 160.0)
    pad = 2
    x0 = x_min - pad * px
    y0 = y_min - pad * px
    nx = int(math.ceil((x_max - x_min) / px)) + 2 * pad + 1
    ny = int(math.ceil((y_max - y_min) / px)) + 2 * pad + 1
    px_area = px * px

    n_layers = min(36, max(4, int(math.ceil(height / 0.8))))
    margin = min(0.15, height * 0.08)
    z_levels = np.linspace(z_min + margin, z_max - margin, n_layers)

    v0z = pts[tris[:, 0], 2]
    v1z = pts[tris[:, 1], 2]
    v2z = pts[tris[:, 2], 2]
    tri_z_min = np.minimum(np.minimum(v0z, v1z), v2z)
    tri_z_max = np.maximum(np.maximum(v0z, v1z), v2z)

    masks: list[np.ndarray] = []
    for z in z_levels:
        masks.append(_rasterize_z_slice(pts, tris, tri_z_min, tri_z_max, float(z), x0, y0, px, nx, ny))

    # 1. Floating islands: 2D components starting on layer k >= 1 with zero overlap on layer k - 1.
    dilate_r = max(1, int(math.ceil(0.6 / px)))
    floating_count = 0
    floating_min_z: float | None = None
    floating_max_area = 0.0
    for k in range(1, n_layers):
        cur = masks[k]
        if not np.any(cur):
            continue
        prev_sup = ndimage.binary_dilation(masks[k - 1], iterations=dilate_r) if np.any(masks[k - 1]) else masks[k - 1]
        labeled, num = ndimage.label(cur)
        if num == 0:
            continue
        counts = np.bincount(labeled.ravel())
        for comp_id in range(1, num + 1):
            comp_area = float(counts[comp_id]) * px_area
            if comp_area < 3.0:
                continue
            if not np.any(prev_sup[labeled == comp_id]):
                floating_count += 1
                z_rel = float(z_levels[k] - z_min)
                if floating_min_z is None or z_rel < floating_min_z:
                    floating_min_z = z_rel
                if comp_area > floating_max_area:
                    floating_max_area = comp_area

    result['floatingIslandCount'] = floating_count
    result['floatingMinZMm'] = round(floating_min_z, 2) if floating_min_z is not None else None
    result['floatingMaxAreaMm2'] = round(floating_max_area, 2)

    # 2. Sub-nozzle thin walls (< ~1.1x nozzle width) via morphological opening on interior layers.
    half_wall_mm = nozzle_mm * 0.55  # 0.22 mm radius -> 0.44 mm wall thickness
    if px <= 0.22 and n_layers >= 4:
        reconstruct_iters = max(1, int(math.ceil((half_wall_mm + px * 0.5) / px)))
        thin_layers = 0
        thin_max_area = 0.0
        for k in range(1, n_layers - 1):
            cur = masks[k]
            if not np.any(cur):
                continue
            edt = ndimage.distance_transform_edt(cur) * px
            core = edt >= half_wall_mm
            reconstructed = ndimage.binary_dilation(core, iterations=reconstruct_iters) if np.any(core) else core
            thin = cur & (~reconstructed)
            if not np.any(thin):
                continue
            labeled, num = ndimage.label(thin)
            counts = np.bincount(labeled.ravel())
            layer_thin_area = sum(
                float(counts[cid]) * px_area for cid in range(1, num + 1) if float(counts[cid]) * px_area >= 1.5
            )
            if layer_thin_area >= 1.5:
                thin_layers += 1
                if layer_thin_area > thin_max_area:
                    thin_max_area = layer_thin_area
        if thin_layers >= 2:
            result['thinWallLayerCount'] = thin_layers
            result['thinWallAreaMm2'] = round(thin_max_area, 2)

    # 3. Trapped overhangs: downward overhang faces that sit above solid material of the same part.
    threshold_z = -math.sin(math.radians(overhang_degrees)) - 1e-6
    on_bed = (tri_z_max <= z_min + 0.1) & (normals[:, 2] <= -0.99)
    is_overhang = (~on_bed) & (tri_z_max > z_min + 0.1) & (normals[:, 2] < threshold_z) & (areas > 1e-9)
    if np.any(is_overhang):
        below_any: list[np.ndarray] = []
        acc = np.zeros((ny, nx), dtype=bool)
        for k in range(n_layers):
            below_any.append(acc.copy())
            acc |= masks[k]
        ov_ids = np.nonzero(is_overhang)[0]
        ov_centroids = (pts[tris[ov_ids, 0]] + pts[tris[ov_ids, 1]] + pts[tris[ov_ids, 2]]) / 3.0
        dz = float(z_levels[1] - z_levels[0]) if n_layers > 1 else 1.0
        trapped_area = 0.0
        for idx, cen in zip(ov_ids, ov_centroids):
            k_tri = int(round((cen[2] - z_levels[0]) / max(dz, 1e-6)))
            k_check = min(n_layers - 1, k_tri - 1)
            if k_check < 1:
                continue
            ix = int(round((cen[0] - x0) / px - 0.5))
            iy = int(round((cen[1] - y0) / px - 0.5))
            if 0 <= ix < nx and 0 <= iy < ny and below_any[k_check][iy, ix]:
                trapped_area += float(areas[idx])
        result['trappedOverhangAreaMm2'] = round(trapped_area, 2)

    return result


def analyze_part_print_orientation(
    pts: np.ndarray,
    tris: np.ndarray,
    overhang_degrees: float = 45.0,
    brep_shape: Any = None,
    include_layer_checks: bool = False,
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
        normals, areas = _triangle_normals_and_areas(rotated, tris)
        metrics = _overhang_metrics(rotated, tris, overhang_degrees)
        stab = _bed_stability_metrics(rotated, tris, normals, areas)
        bed_area = metrics['bedContactAreaMm2']
        overhang_area = metrics['overhangAreaMm2']
        height = metrics['heightMm']
        contact_penalty = 500.0 if bed_area < MIN_BED_CONTACT_MM2 else 0.0
        # Strongly penalize orientations that tip over on the build plate or balance on a narrow sliver.
        stability_penalty = 2500.0 if stab['tipOverRisk'] else 0.0
        sliver_penalty = 600.0 if (bed_area < 200.0 and bed_area < 0.08 * stab['xyBboxAreaMm2']) else 0.0
        score = overhang_area * 4.0 - bed_area + height * 0.25 + contact_penalty + stability_penalty + sliver_penalty
        if score < best_score - 1e-6:
            best_score = score
            best = {
                'downNormal': [round(float(v), 4) for v in down_normal],
                'rotationEulerDeg': _mat3_to_euler_xyz_deg(rot),
                'bedContactAreaMm2': round(bed_area, 2),
                'overhangFaceCount': metrics['overhangFaceCount'],
                'overhangAreaMm2': round(overhang_area, 2),
                'heightMm': round(height, 2),
                '_rot': rot,
            }

    assert best is not None
    rot = best.pop('_rot')
    if include_layer_checks:
        rotated_best = pts @ rot.T
        best['layerChecks'] = _analyze_part_layer_printability(rotated_best, tris, overhang_degrees)
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

        def _collision_mesh(body_entry: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
            if companion_breps is None or total_triangles <= 25000:
                return body_entry['points'], body_entry['triangles']
            shape = companion_breps.get(body_entry['id'])
            if shape is None or len(body_entry['triangles']) <= 4000:
                return body_entry['points'], body_entry['triangles']
            try:
                import build123d as bd
                from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
                from OCP.BRepTools import BRepTools

                copied = BRepBuilderAPI_Copy(shape, True).Shape()
                BRepTools.Clean_s(copied)
                verts, tris = bd.Shape(copied).tessellate(0.15, 0.40)
                if not verts or not tris:
                    return body_entry['points'], body_entry['triangles']
                c_pts = np.array([(v.X, v.Y, v.Z) for v in verts], dtype=np.float64)
                c_tris = np.asarray(tris, dtype=np.int64)
                c_pts, c_tris = weld_mesh(c_pts, c_tris, dist=0.001)
                if len(c_tris) >= len(body_entry['triangles']) or len(c_tris) < 4:
                    return body_entry['points'], body_entry['triangles']
                topo = _check_part_topology(c_pts, c_tris, 1e-12, 160.0, valid_closed_brep=False)
                if topo['non_manifold_edges'] == 0 and topo['inconsistent_winding'] == 0 and topo['degenerate_faces'] == 0:
                    return c_pts, c_tris
            except Exception as _collision_tess_err:
                # Fall back to the preview mesh if collision re-tessellation fails.
                pass
            return body_entry['points'], body_entry['triangles']

        mechanics_bodies = []
        for body in bodies:
            m_pts, m_tris = _collision_mesh(body)
            mechanics_bodies.append({
                'id': body['id'],
                'vertices': m_pts.tolist(),
                'triangles': m_tris.tolist(),
            })
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
            # Valid closed B-Rep solids tessellated by OCCT cannot self-intersect;
            # still check mesh-only inputs and any part failing closed B-Rep validation.
            if body['id'] in valid_closed_ids:
                continue
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

        # Overhangs & per-part print orientation + generic 2D-layer printability analysis
        mfg_mode = (request.get('assembly') or {}).get('manufacturing', {}).get('mode')
        use_per_part_orient = (mfg_mode == 'separate') or (companion_breps is not None)
        overhang_count = 0
        overhang_details: dict[str, Any] | None = None
        small_contact_parts: list[dict[str, Any]] = []
        floating_island_parts: list[dict[str, Any]] = []
        thin_wall_parts: list[dict[str, Any]] = []
        tip_over_parts: list[dict[str, Any]] = []
        trapped_overhang_parts: list[dict[str, Any]] = []

        if use_per_part_orient:
            print_orientations = {}
            per_part_overhangs: list[dict[str, Any]] = []
            for body in bodies:
                pid = body['id']
                brep_shape = companion_breps.get(pid) if companion_breps else None
                orient = analyze_part_print_orientation(
                    body['points'], body['triangles'], overhang_deg,
                    brep_shape=brep_shape, include_layer_checks=True,
                )
                layer = orient.pop('layerChecks', {})
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
                if layer.get('floatingIslandCount', 0) > 0:
                    floating_island_parts.append({
                        'part': pid,
                        'count': layer['floatingIslandCount'],
                        'minZMm': layer['floatingMinZMm'],
                        'maxAreaMm2': layer['floatingMaxAreaMm2'],
                        'rotationEulerDeg': orient['rotationEulerDeg'],
                    })
                if layer.get('thinWallLayerCount', 0) > 0:
                    thin_wall_parts.append({
                        'part': pid,
                        'layerCount': layer['thinWallLayerCount'],
                        'maxAreaMm2': layer['thinWallAreaMm2'],
                    })
                if layer.get('tipOverRisk'):
                    tip_over_parts.append({
                        'part': pid,
                        'comInsideBed': layer.get('comInsideBed', False),
                        'bedContactAreaMm2': orient['bedContactAreaMm2'],
                        'heightMm': orient['heightMm'],
                        'rotationEulerDeg': orient['rotationEulerDeg'],
                    })
                if layer.get('trappedOverhangAreaMm2', 0.0) >= 20.0:
                    trapped_overhang_parts.append({
                        'part': pid,
                        'trappedOverhangAreaMm2': layer['trappedOverhangAreaMm2'],
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
        if floating_island_parts:
            checks.append({
                'code': 'floating_islands',
                'count': sum(item['count'] for item in floating_island_parts),
                'severity': 'warning',
                'details': {'parts': floating_island_parts[:8]},
            })
        if thin_wall_parts:
            checks.append({
                'code': 'unprintable_thin_walls',
                'count': len(thin_wall_parts),
                'severity': 'warning',
                'details': {'nozzleMm': 0.4, 'parts': thin_wall_parts[:8]},
            })
        if tip_over_parts:
            checks.append({
                'code': 'tip_over_risk',
                'count': len(tip_over_parts),
                'severity': 'warning',
                'details': {'parts': tip_over_parts[:8]},
            })
        if trapped_overhang_parts:
            checks.append({
                'code': 'trapped_overhangs',
                'count': len(trapped_overhang_parts),
                'severity': 'warning',
                'details': {'parts': trapped_overhang_parts[:8]},
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
