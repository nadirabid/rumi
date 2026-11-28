"""Pure Python + NumPy triangle-triangle intersection checks for preview geometry.

Replaces Blender's BVH overlap checker with a spatial hash + vectorized Möller–Trumbore
(plus coplanar 2D fallback) engine. Preserves the exact JSON input/output contract of
blender/control-geometry.py (`version: 1, cases: [...]`).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

_EPS = 1e-9
_MAX_CELLS_PER_TRI = 64


def _seg_tri_intersect_batch(
    p0: np.ndarray,
    p1: np.ndarray,
    v0: np.ndarray,
    v1: np.ndarray,
    v2: np.ndarray,
    strict_interior: bool = False,
) -> np.ndarray:
    """Vectorized Möller–Trumbore segment [p0, p1] vs triangle (v0, v1, v2) test."""
    d = p1 - p0
    e1 = v1 - v0
    e2 = v2 - v0
    h = np.cross(d, e2)
    a = np.einsum('ij,ij->i', e1, h)
    non_parallel = np.abs(a) > _EPS
    safe_a = np.where(non_parallel, a, 1.0)
    f = 1.0 / safe_a
    s = p0 - v0
    u = f * np.einsum('ij,ij->i', s, h)
    q = np.cross(s, e1)
    v = f * np.einsum('ij,ij->i', d, q)
    t = f * np.einsum('ij,ij->i', e2, q)
    if strict_interior:
        return (
            non_parallel
            & (u >= -1e-7)
            & (v >= -1e-7)
            & (u + v <= 1.0 + 1e-7)
            & (t > 1e-5)
            & (t < 1.0 - 1e-5)
        )
    return (
        non_parallel
        & (u >= -1e-7)
        & (v >= -1e-7)
        & (u + v <= 1.0 + 1e-7)
        & (t >= -1e-7)
        & (t <= 1.0 + 1e-7)
    )


def _orient2d(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _on_segment2d(ax: float, ay: float, bx: float, by: float, px: float, py: float) -> bool:
    return (
        min(ax, bx) - 1e-7 <= px <= max(ax, bx) + 1e-7
        and min(ay, by) - 1e-7 <= py <= max(ay, by) + 1e-7
    )


def _segments_intersect_2d(
    a0: tuple[float, float],
    a1: tuple[float, float],
    b0: tuple[float, float],
    b1: tuple[float, float],
) -> bool:
    o1 = _orient2d(a0[0], a0[1], a1[0], a1[1], b0[0], b0[1])
    o2 = _orient2d(a0[0], a0[1], a1[0], a1[1], b1[0], b1[1])
    o3 = _orient2d(b0[0], b0[1], b1[0], b1[1], a0[0], a0[1])
    o4 = _orient2d(b0[0], b0[1], b1[0], b1[1], a1[0], a1[1])
    if (o1 > 1e-9 and o2 < -1e-9 or o1 < -1e-9 and o2 > 1e-9) and (
        o3 > 1e-9 and o4 < -1e-9 or o3 < -1e-9 and o4 > 1e-9
    ):
        return True
    if abs(o1) <= 1e-9 and _on_segment2d(a0[0], a0[1], a1[0], a1[1], b0[0], b0[1]):
        return True
    if abs(o2) <= 1e-9 and _on_segment2d(a0[0], a0[1], a1[0], a1[1], b1[0], b1[1]):
        return True
    if abs(o3) <= 1e-9 and _on_segment2d(b0[0], b0[1], b1[0], b1[1], a0[0], a0[1]):
        return True
    if abs(o4) <= 1e-9 and _on_segment2d(b0[0], b0[1], b1[0], b1[1], a1[0], a1[1]):
        return True
    return False


def _point_in_tri_2d(
    p: tuple[float, float],
    t0: tuple[float, float],
    t1: tuple[float, float],
    t2: tuple[float, float],
) -> bool:
    d1 = _orient2d(t0[0], t0[1], t1[0], t1[1], p[0], p[1])
    d2 = _orient2d(t1[0], t1[1], t2[0], t2[1], p[0], p[1])
    d3 = _orient2d(t2[0], t2[1], t0[0], t0[1], p[0], p[1])
    has_neg = (d1 < -1e-9) or (d2 < -1e-9) or (d3 < -1e-9)
    has_pos = (d1 > 1e-9) or (d2 > 1e-9) or (d3 > 1e-9)
    return not (has_neg and has_pos)


def _coplanar_tris_intersect(
    a0: np.ndarray, a1: np.ndarray, a2: np.ndarray,
    b0: np.ndarray, b1: np.ndarray, b2: np.ndarray,
    normal: np.ndarray,
) -> bool:
    """Exact 2D overlap test for coplanar triangles projected along the dominant normal axis."""
    drop = int(np.argmax(np.abs(normal)))
    axes = [ax for ax in (0, 1, 2) if ax != drop]
    ta = [(float(p[axes[0]]), float(p[axes[1]])) for p in (a0, a1, a2)]
    tb = [(float(p[axes[0]]), float(p[axes[1]])) for p in (b0, b1, b2)]
    for i in range(3):
        for j in range(3):
            if _segments_intersect_2d(ta[i], ta[(i + 1) % 3], tb[j], tb[(j + 1) % 3]):
                return True
    if _point_in_tri_2d(ta[0], tb[0], tb[1], tb[2]):
        return True
    if _point_in_tri_2d(tb[0], ta[0], ta[1], ta[2]):
        return True
    return False


def _test_candidate_pairs(
    v0: np.ndarray,
    v1: np.ndarray,
    v2: np.ndarray,
    idx_a: np.ndarray,
    idx_b: np.ndarray,
    strict_interior: bool = False,
) -> np.ndarray:
    """Return boolean mask of truly intersecting triangle pairs."""
    if len(idx_a) == 0:
        return np.zeros(0, dtype=bool)
    a0, a1, a2 = v0[idx_a], v1[idx_a], v2[idx_a]
    b0, b1, b2 = v0[idx_b], v1[idx_b], v2[idx_b]

    # Plane separation reject: check if all vertices of B lie strictly on one side of A's plane.
    na = np.cross(a1 - a0, a2 - a0)
    na_len = np.linalg.norm(na, axis=1)
    nb = np.cross(b1 - b0, b2 - b0)
    nb_len = np.linalg.norm(nb, axis=1)
    valid = (na_len > 1e-15) & (nb_len > 1e-15)
    if not np.any(valid):
        return np.zeros(len(idx_a), dtype=bool)

    na_unit = np.divide(na, np.where(valid, na_len, 1.0)[:, None])
    nb_unit = np.divide(nb, np.where(valid, nb_len, 1.0)[:, None])

    db0 = np.einsum('ij,ij->i', b0 - a0, na_unit)
    db1 = np.einsum('ij,ij->i', b1 - a0, na_unit)
    db2 = np.einsum('ij,ij->i', b2 - a0, na_unit)
    sep_a = ((db0 > 1e-7) & (db1 > 1e-7) & (db2 > 1e-7)) | ((db0 < -1e-7) & (db1 < -1e-7) & (db2 < -1e-7))

    da0 = np.einsum('ij,ij->i', a0 - b0, nb_unit)
    da1 = np.einsum('ij,ij->i', a1 - b0, nb_unit)
    da2 = np.einsum('ij,ij->i', a2 - b0, nb_unit)
    sep_b = ((da0 > 1e-7) & (da1 > 1e-7) & (da2 > 1e-7)) | ((da0 < -1e-7) & (da1 < -1e-7) & (da2 < -1e-7))

    active_idx = np.nonzero(valid & ~sep_a & ~sep_b)[0]
    hits = np.zeros(len(idx_a), dtype=bool)
    if len(active_idx) == 0:
        return hits

    # Distinguish coplanar vs non-coplanar active pairs.
    coplanar_local = (
        (np.abs(db0[active_idx]) <= 1e-7)
        & (np.abs(db1[active_idx]) <= 1e-7)
        & (np.abs(db2[active_idx]) <= 1e-7)
    )
    non_cop = active_idx[~coplanar_local]
    if len(non_cop) > 0:
        aa0, aa1, aa2 = a0[non_cop], a1[non_cop], a2[non_cop]
        bb0, bb1, bb2 = b0[non_cop], b1[non_cop], b2[non_cop]
        hit = (
            _seg_tri_intersect_batch(aa0, aa1, bb0, bb1, bb2, strict_interior=strict_interior)
            | _seg_tri_intersect_batch(aa1, aa2, bb0, bb1, bb2, strict_interior=strict_interior)
            | _seg_tri_intersect_batch(aa2, aa0, bb0, bb1, bb2, strict_interior=strict_interior)
            | _seg_tri_intersect_batch(bb0, bb1, aa0, aa1, aa2, strict_interior=strict_interior)
            | _seg_tri_intersect_batch(bb1, bb2, aa0, aa1, aa2, strict_interior=strict_interior)
            | _seg_tri_intersect_batch(bb2, bb0, aa0, aa1, aa2, strict_interior=strict_interior)
        )
        hits[non_cop] = hit

    if not strict_interior:
        cop_idx = active_idx[coplanar_local]
        for k in cop_idx:
            if _coplanar_tris_intersect(a0[k], a1[k], a2[k], b0[k], b1[k], b2[k], na_unit[k]):
                hits[k] = True

    return hits


def intersections(
    points: Any,
    triangles: Any,
    topology: list[set[Any]] | list[frozenset[Any]],
    strict_interior: bool = False,
) -> set[tuple[int, int]]:
    """Return nonadjacent intersecting triangle pairs (a, b) with a < b."""
    pts = np.asarray(points, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    n_tris = len(tris)
    if n_tris < 2:
        return set()

    v0 = pts[tris[:, 0]]
    v1 = pts[tris[:, 1]]
    v2 = pts[tris[:, 2]]
    tri_min = np.minimum(np.minimum(v0, v1), v2) - 1e-7
    tri_max = np.maximum(np.maximum(v0, v1), v2) + 1e-7

    extents = tri_max - tri_min
    positive = extents[extents > 1e-9]
    cell_size = float(np.median(positive) * 2.0) if len(positive) else 1.0
    if not np.isfinite(cell_size) or cell_size < 1e-6:
        cell_size = 1.0

    origin = tri_min.min(axis=0)
    min_cell = np.floor((tri_min - origin) / cell_size).astype(np.int64)
    max_cell = np.floor((tri_max - origin) / cell_size).astype(np.int64)
    span = max_cell - min_cell + 1
    cell_counts = span[:, 0] * span[:, 1] * span[:, 2]

    grid: dict[tuple[int, int, int], list[int]] = {}
    large: list[int] = []
    for idx in range(n_tris):
        if int(cell_counts[idx]) > _MAX_CELLS_PER_TRI:
            large.append(idx)
            continue
        x0, y0, z0 = int(min_cell[idx, 0]), int(min_cell[idx, 1]), int(min_cell[idx, 2])
        x1, y1, z1 = int(max_cell[idx, 0]), int(max_cell[idx, 1]), int(max_cell[idx, 2])
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                for cz in range(z0, z1 + 1):
                    key = (cx, cy, cz)
                    bucket = grid.get(key)
                    if bucket is None:
                        grid[key] = [idx]
                    else:
                        bucket.append(idx)

    candidates: set[tuple[int, int]] = set()
    for bucket in grid.values():
        m = len(bucket)
        if m < 2:
            continue
        if m <= 48:
            for i in range(m):
                a = bucket[i]
                ax0, ay0, az0 = tri_min[a]
                ax1, ay1, az1 = tri_max[a]
                ta = topology[a]
                for j in range(i + 1, m):
                    b = bucket[j]
                    if (
                        ax1 >= tri_min[b, 0] and tri_max[b, 0] >= ax0
                        and ay1 >= tri_min[b, 1] and tri_max[b, 1] >= ay0
                        and az1 >= tri_min[b, 2] and tri_max[b, 2] >= az0
                    ):
                        pair = (a, b) if a < b else (b, a)
                        if pair not in candidates and not ta.intersection(topology[b]):
                            candidates.add(pair)
        else:
            arr = np.asarray(bucket, dtype=np.int64)
            bmin = tri_min[arr]
            bmax = tri_max[arr]
            for i in range(m - 1):
                a = int(arr[i])
                rest = arr[i + 1:]
                overlap = (
                    (bmax[i, 0] >= bmin[i + 1:, 0]) & (bmax[i + 1:, 0] >= bmin[i, 0])
                    & (bmax[i, 1] >= bmin[i + 1:, 1]) & (bmax[i + 1:, 1] >= bmin[i, 1])
                    & (bmax[i, 2] >= bmin[i + 1:, 2]) & (bmax[i + 1:, 2] >= bmin[i, 2])
                )
                ta = topology[a]
                for b_val in rest[overlap]:
                    b = int(b_val)
                    pair = (a, b) if a < b else (b, a)
                    if pair not in candidates and not ta.intersection(topology[b]):
                        candidates.add(pair)

    # Check oversized triangles against all triangles via vectorized AABB overlap.
    for a in large:
        overlap = (
            (tri_max[a, 0] >= tri_min[:, 0]) & (tri_max[:, 0] >= tri_min[a, 0])
            & (tri_max[a, 1] >= tri_min[:, 1]) & (tri_max[:, 1] >= tri_min[a, 1])
            & (tri_max[a, 2] >= tri_min[:, 2]) & (tri_max[:, 2] >= tri_min[a, 2])
        )
        overlap[a] = False
        ta = topology[a]
        for b_val in np.nonzero(overlap)[0]:
            b = int(b_val)
            pair = (a, b) if a < b else (b, a)
            if pair not in candidates and not ta.intersection(topology[b]):
                candidates.add(pair)

    if not candidates:
        return set()

    pair_list = sorted(candidates)
    idx_a = np.fromiter((p[0] for p in pair_list), dtype=np.int64, count=len(pair_list))
    idx_b = np.fromiter((p[1] for p in pair_list), dtype=np.int64, count=len(pair_list))

    # Process in bounded batches so memory stays O(batch_size).
    found: set[tuple[int, int]] = set()
    batch = 8192
    for start in range(0, len(pair_list), batch):
        end = min(start + batch, len(pair_list))
        mask = _test_candidate_pairs(
            v0, v1, v2, idx_a[start:end], idx_b[start:end], strict_interior=strict_interior,
        )
        for offset in np.nonzero(mask)[0]:
            found.add(pair_list[start + int(offset)])
    return found


def check(request: dict[str, Any]) -> dict[str, Any]:
    """Check every requested endpoint without writing model geometry."""
    base = json.loads(Path(request['baseline']).read_text(encoding='utf-8'))
    triangles = base['triangles']
    # USD expands shared triangle vertices; weld only within each source part.
    keys = [(part, *(round(v, 5) for v in point)) for part, point in zip(base['parts'], base['points'])]
    topology = [frozenset(keys[v] for v in triangle) for triangle in triangles]
    baseline = intersections(base['points'], triangles, topology)
    results = []
    for case in request['cases']:
        points = json.loads(Path(case['path']).read_text(encoding='utf-8'))
        current = intersections(points, triangles, topology)
        added = sorted(current - baseline)
        results.append({
            'id': case['id'],
            'baselineIntersectionPairs': len(baseline),
            'intersectionPairs': len(current),
            'newIntersectionPairs': len(added),
            'examples': [{'triangles': [a, b], 'location': points[triangles[a][0]]} for a, b in added[:5]],
        })
    return {'version': 1, 'cases': results}


def _request_path_from_argv(argv: list[str]) -> str:
    if '--' in argv:
        return argv[argv.index('--') + 1]
    if len(argv) >= 2:
        return argv[1]
    raise SystemExit('Usage: control_geometry.py [--] <request.json>')


if __name__ == '__main__':
    request = json.loads(Path(_request_path_from_argv(sys.argv)).read_text(encoding='utf-8'))
    Path(request['output']).write_text(json.dumps(check(request)), encoding='utf-8')
