"""Millimetre B-Rep modelling kit and separate-print joint recipes for Rumi CAD scripts.

Load with `K = types.SimpleNamespace(**runpy.run_path(joints_path))`. Every length, position,
and pivot is in millimetres, Z up. Geometry is exact OpenCASCADE B-Rep built with `build123d`.

Recipes are separate-print starting points: every moving joint produces flat-printable parts,
verifiable clearances (>= 0.3 mm), joint records, and disassembly steps that `publish` collects
into the USD + STEP assembly. Recipes live in `joints/*.py`.
"""
from __future__ import annotations

import math
import runpy
from pathlib import Path
from typing import Iterable

import build123d as b3d
import numpy as np

_HERE = Path(__file__).resolve().parent
_AXES = {'X': (1.0, 0.0, 0.0), 'Y': (0.0, 1.0, 0.0), 'Z': (0.0, 0.0, 1.0)}
_RETAINER_MODES = ('rigid', 'bayonet', 'threaded', 'snap', 'friction')

_SCENE: dict[str, 'CadPart'] = {}


# ---------------------------------------------------------------- vectors & frames

class Vec3(tuple):
    """Immutable 3D millimetre vector supporting attribute access, indexing, and arithmetic."""

    def __new__(cls, values):
        if isinstance(values, Vec3):
            return values
        if isinstance(values, b3d.Vector):
            coords = (float(values.X), float(values.Y), float(values.Z))
        else:
            coords = tuple(float(v) for v in values)
        if len(coords) != 3 or not all(math.isfinite(v) for v in coords):
            raise ValueError('Expected three finite coordinates')
        return super().__new__(cls, coords)

    @property
    def x(self) -> float:
        return self[0]

    @property
    def y(self) -> float:
        return self[1]

    @property
    def z(self) -> float:
        return self[2]

    @property
    def length(self) -> float:
        return math.sqrt(self[0] ** 2 + self[1] ** 2 + self[2] ** 2)

    def dot(self, other) -> float:
        o = Vec3(other)
        return self[0] * o[0] + self[1] * o[1] + self[2] * o[2]

    def cross(self, other) -> 'Vec3':
        o = Vec3(other)
        return Vec3((
            self[1] * o[2] - self[2] * o[1],
            self[2] * o[0] - self[0] * o[2],
            self[0] * o[1] - self[1] * o[0],
        ))

    def normalized(self) -> 'Vec3':
        n = self.length
        if n < 1e-12:
            raise ValueError('Cannot normalize a zero-length vector')
        return Vec3((self[0] / n, self[1] / n, self[2] / n))

    def __add__(self, other) -> 'Vec3':
        o = Vec3(other)
        return Vec3((self[0] + o[0], self[1] + o[1], self[2] + o[2]))

    def __sub__(self, other) -> 'Vec3':
        o = Vec3(other)
        return Vec3((self[0] - o[0], self[1] - o[1], self[2] - o[2]))

    def __neg__(self) -> 'Vec3':
        return Vec3((-self[0], -self[1], -self[2]))

    def __mul__(self, scalar: float) -> 'Vec3':
        s = float(scalar)
        return Vec3((self[0] * s, self[1] * s, self[2] * s))

    def __rmul__(self, scalar: float) -> 'Vec3':
        return self.__mul__(scalar)

    def __truediv__(self, scalar: float) -> 'Vec3':
        s = float(scalar)
        return Vec3((self[0] / s, self[1] / s, self[2] / s))

    def to_b3d(self) -> b3d.Vector:
        return b3d.Vector(self[0], self[1], self[2])


def direction(value) -> Vec3:
    """Return a unit Vec3 for '+X', '-Z', 'Y', or an (x, y, z) tuple."""
    if isinstance(value, str):
        sign = -1.0 if value.startswith('-') else 1.0
        key = value.lstrip('+-').upper()
        if key not in _AXES:
            raise ValueError(f'Unknown axis string: {value!r}')
        return Vec3(_AXES[key]) * sign
    return Vec3(value).normalized()


class Frame:
    """Right-handed orthonormal frame in millimetres (origin, x_dir, y_dir, z_dir)."""

    def __init__(self, origin: Vec3, x_dir: Vec3, y_dir: Vec3, z_dir: Vec3):
        self.origin = Vec3(origin)
        self.x_dir = Vec3(x_dir)
        self.y_dir = Vec3(y_dir)
        self.z_dir = Vec3(z_dir)
        self._plane = b3d.Plane(
            origin=self.origin.to_b3d(),
            x_dir=self.x_dir.to_b3d(),
            z_dir=self.z_dir.to_b3d(),
        )
        self.location = b3d.Location(self._plane)

    def to_world(self, point) -> Vec3:
        p = Vec3(point)
        return self.origin + self.x_dir * p.x + self.y_dir * p.y + self.z_dir * p.z

    def to_world_dir(self, vec) -> Vec3:
        v = Vec3(vec)
        return self.x_dir * v.x + self.y_dir * v.y + self.z_dir * v.z

    def to_local(self, point) -> Vec3:
        d = Vec3(point) - self.origin
        return Vec3((d.dot(self.x_dir), d.dot(self.y_dir), d.dot(self.z_dir)))

    def to_local_dir(self, vec) -> Vec3:
        v = Vec3(vec)
        return Vec3((v.dot(self.x_dir), v.dot(self.y_dir), v.dot(self.z_dir)))

    def translated(self, local_offset) -> 'Frame':
        return Frame(self.to_world(local_offset), self.x_dir, self.y_dir, self.z_dir)

    def __matmul__(self, other):
        if isinstance(other, Frame):
            return Frame(
                self.to_world(other.origin),
                self.to_world_dir(other.x_dir),
                self.to_world_dir(other.y_dir),
                self.to_world_dir(other.z_dir),
            )
        return self.to_world(other)


def frame(pivot, axis, xdir=None) -> Frame:
    """Right-handed frame placing local Z on `axis` and local X on `xdir` (orthogonalized), origin at `pivot` in mm."""
    z = direction(axis)
    if xdir is not None:
        raw_x = direction(xdir)
    else:
        raw_x = Vec3((1.0, 0.0, 0.0)) if abs(z.x) < 0.9 else Vec3((0.0, 1.0, 0.0))
    proj = raw_x - z * raw_x.dot(z)
    if proj.length < 1e-6:
        raise ValueError('xdir must not be parallel to the axis')
    x = proj.normalized()
    y = z.cross(x).normalized()
    return Frame(Vec3(pivot), x, y, z)


# ---------------------------------------------------------------- 2D outline helper

def outline_distances(points, outlines, batch_size=256):
    """Return exact shortest distances from 2D points to closed outline segments."""
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1:
        raise ValueError('batch_size must be a positive integer')
    pts = np.asarray(points, dtype=np.float64)
    if pts.shape == (0,):
        pts = pts.reshape(0, 2)
    if pts.ndim != 2 or pts.shape[1] != 2 or not np.isfinite(pts).all():
        raise ValueError('points must be finite 2D coordinates')
    starts, ends = [], []
    for outline in outlines:
        values = np.asarray(outline, dtype=np.float64)
        if values.ndim != 2 or values.shape[1] != 2 or not len(values) or not np.isfinite(values).all():
            raise ValueError('Each outline must contain finite 2D coordinates')
        starts.append(values)
        ends.append(np.roll(values, -1, axis=0))
    if not starts:
        raise ValueError('At least one outline is required')
    starts, ends = np.concatenate(starts), np.concatenate(ends)
    vectors = ends - starts
    lengths = np.sum(vectors * vectors, axis=1)
    lengths[lengths == 0] = 1
    result = np.full(len(pts), np.inf)
    for offset in range(0, len(pts), batch_size):
        current = pts[offset:offset + batch_size]
        best = np.full(len(current), np.inf)
        for segment in range(0, len(starts), batch_size):
            origin = starts[segment:segment + batch_size]
            vector = vectors[segment:segment + batch_size]
            dx = current[:, 0, None] - origin[:, 0]
            dy = current[:, 1, None] - origin[:, 1]
            fraction = np.clip((dx * vector[:, 0] + dy * vector[:, 1]) / lengths[segment:segment + batch_size], 0, 1)
            dx = current[:, 0, None] - (origin[:, 0] + fraction * vector[:, 0])
            dy = current[:, 1, None] - (origin[:, 1] + fraction * vector[:, 1])
            best = np.minimum(best, np.min(dx * dx + dy * dy, axis=1))
        result[offset:offset + batch_size] = np.sqrt(best)
    return result


# ---------------------------------------------------------------- part wrapper & scene

class CadPart:
    """Mutable handle wrapping a named build123d B-Rep solid (millimetres, Z-up)."""

    def __init__(self, name: str, shape: b3d.Shape, color=None):
        if not isinstance(name, str) or not name.strip():
            raise ValueError('Part name must be a non-empty string')
        self.name = name
        self.shape = _as_part(shape)
        self.color = color
        self.meta: dict = {}
        self._sync_shape_attrs()

    @property
    def label(self) -> str:
        return self.name

    @label.setter
    def label(self, value: str):
        self.name = value
        self._sync_shape_attrs()

    def _sync_shape_attrs(self):
        self.shape.label = self.name
        if self.color is not None:
            self.shape.color = b3d.Color(*self.color)

    def to_build123d(self) -> b3d.Shape:
        """Return a build123d Shape carrying this part's label and optional color."""
        out = b3d.Part(self.shape.wrapped)
        out.label = self.name
        if self.color is not None:
            out.color = b3d.Color(*self.color)
        if '_rumi_features' in self.meta:
            setattr(out, '_rumi_features', list(self.meta['_rumi_features']))
        return out

    def get(self, key: str, default=None):
        return self.meta.get(key, default)

    def __getitem__(self, key: str):
        return self.meta[key]

    def __setitem__(self, key: str, value):
        self.meta[key] = value

    def __repr__(self) -> str:
        return f'CadPart({self.name!r}, solids={len(self.shape.solids())}, vol={self.shape.volume:.1f}mm3)'


def _as_part(shape) -> b3d.Part:
    if isinstance(shape, CadPart):
        return shape.shape
    if isinstance(shape, b3d.Part):
        return shape
    if isinstance(shape, b3d.Shape):
        return b3d.Part(shape.wrapped)
    raise TypeError(f'Expected CadPart or build123d Shape, got {type(shape).__name__}')


def _register(name: str, shape: b3d.Shape, color=None) -> CadPart:
    obj = CadPart(name, shape, color=color)
    if not name.startswith('_'):
        _SCENE[name] = obj
    return obj


def register(name: str, shape: b3d.Shape, color=None) -> CadPart:
    """Register a custom build123d Shape (or CadPart) in the active scene under `name`."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('register: name must be a non-empty string')
    rgba = None
    if color is not None:
        values = tuple(float(c) for c in color)
        if len(values) == 3:
            values = (*values, 1.0)
        if len(values) != 4 or not all(0.0 <= c <= 1.0 for c in values):
            raise ValueError('register: color must be 3 or 4 floats in 0..1')
        rgba = values
    return _register(name, shape, color=rgba)


def start():
    """Reset the active CAD scene. Call once at the top of a build script."""
    _SCENE.clear()


def part(name: str) -> CadPart:
    """Fetch a named part from the active scene."""
    if name not in _SCENE:
        raise KeyError(f'No part named {name!r} in the active scene')
    return _SCENE[name]


def parts() -> list[CadPart]:
    """Return all active non-helper parts in creation order."""
    return list(_SCENE.values())


def discard(*objects):
    """Remove helper or unused parts from the active scene so they are not published."""
    for obj in objects:
        if isinstance(obj, CadPart):
            if _SCENE.get(obj.name) is obj:
                del _SCENE[obj.name]
        elif isinstance(obj, str) and obj in _SCENE:
            del _SCENE[obj]


# ---------------------------------------------------------------- solid primitives

def _orient_loc(center, axis='Z', xdir=None) -> b3d.Location:
    return frame(center, axis, xdir).location


def box(name: str, size, center=(0, 0, 0)) -> CadPart:
    """Box with full `size` (x, y, z) centred at `center`."""
    sx, sy, sz = (float(v) for v in size)
    if sx <= 0 or sy <= 0 or sz <= 0:
        raise ValueError(f'box {name}: dimensions must be positive, got {size}')
    shape = b3d.Box(sx, sy, sz).moved(b3d.Location(Vec3(center).to_b3d()))
    return _register(name, shape)


def box2(name: str, low, high) -> CadPart:
    """Box spanning from corner `low` to corner `high`."""
    lo, hi = Vec3(low), Vec3(high)
    size = hi - lo
    if size.x <= 0 or size.y <= 0 or size.z <= 0:
        raise ValueError(f'box2 {name}: high must exceed low on all axes, got {low}..{high}')
    return box(name, tuple(size), tuple((lo + hi) / 2))


def cylinder(name: str, radius: float, length: float, center=(0, 0, 0), axis='Z', radius2=None, segments=64) -> CadPart:
    """Analytic cylinder (or cone frustum when `radius2` is given) of `length` centred at `center` along `axis`."""
    r1 = float(radius)
    r2 = r1 if radius2 is None else float(radius2)
    h = float(length)
    if h <= 0 or r1 < 0 or r2 < 0 or (r1 == 0 and r2 == 0):
        raise ValueError(f'cylinder {name}: invalid radius/length ({r1}, {r2}, {h})')
    if abs(r1 - r2) < 1e-9:
        solid = b3d.Cylinder(r1, h)
    else:
        solid = b3d.Cone(r1, r2, h)
    shape = solid.moved(_orient_loc(center, axis))
    return _register(name, shape)


def rod(name: str, radius: float, start_point, end_point, radius2=None, segments=64) -> CadPart:
    """Cylinder (or frustum) between `start_point` and `end_point`."""
    a, b = Vec3(start_point), Vec3(end_point)
    delta = b - a
    if delta.length <= 1e-6:
        raise ValueError(f'rod {name}: start_point and end_point must be distinct')
    return cylinder(name, radius, delta.length, tuple((a + b) / 2), tuple(delta), radius2, segments)


def sphere(name: str, radius: float, center=(0, 0, 0), segments=48) -> CadPart:
    """Analytic sphere of `radius` centred at `center`."""
    r = float(radius)
    if r <= 0:
        raise ValueError(f'sphere {name}: radius must be positive')
    shape = b3d.Sphere(r).moved(b3d.Location(Vec3(center).to_b3d()))
    return _register(name, shape)


def _clean_2d_outline(points) -> list[tuple[float, float]]:
    outline: list[tuple[float, float]] = []
    for u, v in points:
        pt = (float(u), float(v))
        if not outline or math.hypot(pt[0] - outline[-1][0], pt[1] - outline[-1][1]) > 1e-6:
            outline.append(pt)
    if len(outline) > 1 and math.hypot(outline[0][0] - outline[-1][0], outline[0][1] - outline[-1][1]) <= 1e-6:
        outline.pop()
    if len(outline) < 3:
        raise ValueError('prism: outline needs at least three distinct points')
    return outline


def prism(name: str, points, height: float, center=(0, 0, 0), axis='Z', xdir=None) -> CadPart:
    """Extrude a closed 2D outline `[(u, v), ...]` by `height`, centred on `axis` at `center`. Concave outlines work."""
    h = float(height)
    if h <= 0:
        raise ValueError(f'prism {name}: height must be positive')
    outline = _clean_2d_outline(points)
    pts3 = [(u, v, -h / 2) for u, v in outline]
    pts3.append(pts3[0])
    face = b3d.Face(b3d.Wire.make_polygon(pts3))
    solid = b3d.extrude(face, amount=h, dir=(0, 0, 1))
    shape = solid.moved(_orient_loc(center, axis, xdir))
    return _register(name, shape)


def lathe(name: str, profile, center=(0, 0, 0), axis='Z', segments=64) -> CadPart:
    """Revolve a closed 2D profile `[(radius, z), ...]` 360 degrees around `axis` through `center`."""
    cleaned: list[tuple[float, float]] = []
    for r, z in profile:
        rr, zz = float(r), float(z)
        if rr < -1e-6:
            raise ValueError(f'lathe {name}: profile radii must be non-negative, got {rr}')
        rr = max(0.0, rr)
        if not cleaned or math.hypot(rr - cleaned[-1][0], zz - cleaned[-1][1]) > 1e-6:
            cleaned.append((rr, zz))
    if len(cleaned) > 1 and math.hypot(cleaned[0][0] - cleaned[-1][0], cleaned[0][1] - cleaned[-1][1]) <= 1e-6:
        cleaned.pop()
    if len(cleaned) < 3:
        raise ValueError(f'lathe {name}: profile needs at least three distinct points')
    pts3 = [(r, 0.0, z) for r, z in cleaned]
    pts3.append(pts3[0])
    face = b3d.Face(b3d.Wire.make_polygon(pts3))
    solid = b3d.revolve(face, b3d.Axis.Z, 360.0)
    shape = solid.moved(_orient_loc(center, axis))
    return _register(name, shape)


# ---------------------------------------------------------------- CAD operations

def volume(obj) -> float:
    """Exact enclosed B-Rep volume in cubic millimetres."""
    return float(_as_part(obj).volume)


def solids(obj) -> int:
    """Number of disconnected B-Rep solids in the part. A printable part has exactly one."""
    return len(_as_part(obj).solids())


def bounds(obj) -> tuple[Vec3, Vec3]:
    """Return `(low, high)` axis-aligned bounding box corners in millimetres."""
    bb = _as_part(obj).bounding_box()
    return (Vec3((bb.min.X, bb.min.Y, bb.min.Z)), Vec3((bb.max.X, bb.max.Y, bb.max.Z)))


def distance(a, b) -> float:
    """Exact OpenCASCADE minimum surface-to-surface distance in millimetres between two parts."""
    return float(_as_part(a).distance_to(_as_part(b)))


def require_one_solid(obj: CadPart, recipe: str, hint: str):
    """Fail loudly when a recipe leaves a part disconnected or invalid."""
    count = solids(obj)
    if count != 1:
        raise ValueError(f'{recipe}: {obj.name} is {count} separate pieces after adding the joint. {hint}')
    if not obj.shape.is_valid:
        raise ValueError(f'{recipe}: {obj.name} has invalid B-Rep topology after adding the joint. {hint}')


def _update_target(target: CadPart, new_shape: b3d.Shape) -> CadPart:
    cleaned = new_shape.clean() if hasattr(new_shape, 'clean') else new_shape
    target.shape = _as_part(cleaned)
    target._sync_shape_attrs()
    return target


def cut(target: CadPart, *tools, keep: bool = False) -> CadPart:
    """Subtract each tool solid from `target` in place. Consumed tools are removed from the scene unless keep=True."""
    for tool in tools:
        before = volume(target)
        res = target.shape - _as_part(tool)
        _update_target(target, res)
        if volume(target) > before * 1.00001 + 1e-3:
            raise ValueError(f'cut: subtracting from {target.name} added material; B-Rep boolean failed.')
        if not keep and isinstance(tool, CadPart):
            discard(tool)
    return target


def join(target: CadPart, *others, keep: bool = False) -> CadPart:
    """Fuse each solid into `target` in place. Consumed solids are removed from the scene unless keep=True."""
    for other in others:
        before = volume(target)
        res = target.shape + _as_part(other)
        _update_target(target, res)
        if volume(target) < before * 0.99999 - 1e-3:
            raise ValueError(f'join: fusing into {target.name} removed material; B-Rep boolean failed.')
        if not keep and isinstance(other, CadPart):
            discard(other)
    return target


def common(target: CadPart, tool, keep: bool = False) -> CadPart:
    """Intersect `target` with `tool` in place."""
    res = target.shape & _as_part(tool)
    _update_target(target, res)
    if not keep and isinstance(tool, CadPart):
        discard(tool)
    return target


def fillet(target: CadPart, radius: float, edges=None) -> CadPart:
    """Fillet edges of `target` in place. `edges` may be None (all edges), an edge list, or a selector callable(shape)."""
    r = float(radius)
    if r <= 0:
        raise ValueError('fillet: radius must be positive')
    edge_list = edges(target.shape) if callable(edges) else (target.shape.edges() if edges is None else edges)
    if not edge_list:
        return target
    res = b3d.fillet(edge_list, r)
    return _update_target(target, res)


def chamfer(target: CadPart, length: float, length2=None, edges=None) -> CadPart:
    """Chamfer edges of `target` in place. `edges` may be None (all edges), an edge list, or a selector callable(shape)."""
    d1 = float(length)
    if d1 <= 0:
        raise ValueError('chamfer: length must be positive')
    edge_list = edges(target.shape) if callable(edges) else (target.shape.edges() if edges is None else edges)
    if not edge_list:
        return target
    if length2 is None:
        res = b3d.chamfer(edge_list, d1)
    else:
        res = b3d.chamfer(edge_list, d1, float(length2))
    return _update_target(target, res)


def copy(obj: CadPart, name: str) -> CadPart:
    """Duplicate a part with a new name."""
    cloned = b3d.Part(obj.shape.wrapped).moved(b3d.Location((0, 0, 0)))
    dup = _register(name, cloned, color=obj.color)
    dup.meta = dict(obj.meta)
    return dup


def move(obj: CadPart, offset) -> CadPart:
    """Translate `obj` in place by `offset` (dx, dy, dz) in millimetres."""
    loc = b3d.Location(Vec3(offset).to_b3d())
    obj.shape = _as_part(obj.shape.moved(loc))
    obj._sync_shape_attrs()
    return obj


def rotate(obj: CadPart, axis, degrees: float, pivot=(0, 0, 0)) -> CadPart:
    """Rotate `obj` in place by `degrees` about `axis` passing through `pivot`."""
    ax = b3d.Axis(Vec3(pivot).to_b3d(), direction(axis).to_b3d())
    obj.shape = _as_part(obj.shape.rotate(ax, float(degrees)))
    obj._sync_shape_attrs()
    return obj


def mirror(obj: CadPart, axis, name: str | None = None, plane_origin=(0, 0, 0)) -> CadPart:
    """Mirror `obj` across the plane through `plane_origin` normal to `axis`. With `name`, mirrors a copy."""
    normal = direction(axis)
    plane = b3d.Plane(origin=Vec3(plane_origin).to_b3d(), z_dir=normal.to_b3d())
    mirrored = b3d.mirror(obj.shape, about=plane)
    if name is not None:
        return _register(name, mirrored, color=obj.color)
    return _update_target(obj, mirrored)


def place(obj: CadPart, transform) -> CadPart:
    """Apply a `Frame` or `build123d.Location` transform to `obj` built at the origin."""
    loc = transform.location if isinstance(transform, Frame) else transform
    obj.shape = _as_part(obj.shape.moved(loc))
    obj._sync_shape_attrs()
    return obj


def paint(obj: CadPart, rgba) -> CadPart:
    """Assign one surface colour `(r, g, b)` or `(r, g, b, a)` in 0..1."""
    values = tuple(float(c) for c in rgba)
    if len(values) == 3:
        values = (*values, 1.0)
    if len(values) != 4 or not all(0.0 <= c <= 1.0 for c in values):
        raise ValueError('paint: rgba must be 3 or 4 floats in 0..1')
    obj.color = values
    obj._sync_shape_attrs()
    return obj


# ---------------------------------------------------------------- local B-Rep helpers shared by recipes

def _local_extents(obj: CadPart, world: Frame) -> list[tuple[float, float]]:
    """Return `[(x_min, x_max), (y_min, y_max), (z_min, z_max)]` of `obj` in `world`'s local frame."""
    verts = obj.shape.vertices()
    if verts:
        pts = [world.to_local((v.X, v.Y, v.Z)) for v in verts]
    else:
        lo, hi = bounds(obj)
        pts = [world.to_local((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    # Also include tessellated bounding corners for curved faces (cylinders/spheres) whose vertices may not sit on extrema.
    lo, hi = bounds(obj)
    for x in (lo.x, hi.x):
        for y in (lo.y, hi.y):
            for z in (lo.z, hi.z):
                pts.append(world.to_local((x, y, z)))
    # Refine with exact B-Rep bounding box in local coordinates by inverse-moving a copy.
    inv_loc = world.location.inverse()
    local_bb = obj.shape.moved(inv_loc).bounding_box()
    return [
        (float(local_bb.min.X), float(local_bb.max.X)),
        (float(local_bb.min.Y), float(local_bb.max.Y)),
        (float(local_bb.min.Z), float(local_bb.max.Z)),
    ]


def _clear_distance(moving: CadPart, against: Iterable[CadPart], axis_dir: Vec3, margin: float = 12.0) -> float:
    """Compute a positive translation distance along `axis_dir` guaranteeing disjoint AABBs from all `against` parts."""
    ax = direction(axis_dir)
    m_lo, m_hi = bounds(moving)
    m_corners = [Vec3((x, y, z)) for x in (m_lo.x, m_hi.x) for y in (m_lo.y, m_hi.y) for z in (m_lo.z, m_hi.z)]
    m_min_proj = min(c.dot(ax) for c in m_corners)
    need = 20.0
    for other in against:
        if other is moving:
            continue
        o_lo, o_hi = bounds(other)
        o_corners = [Vec3((x, y, z)) for x in (o_lo.x, o_hi.x) for y in (o_lo.y, o_hi.y) for z in (o_lo.z, o_hi.z)]
        o_max_proj = max(c.dot(ax) for c in o_corners)
        # Ensure strict world AABB separation along the dominant component of ax too.
        proj_dist = o_max_proj - m_min_proj + margin
        need = max(need, proj_dist)
        for i in range(3):
            if abs(ax[i]) > 0.25:
                if ax[i] > 0:
                    comp_dist = (o_hi[i] - m_lo[i] + margin) / ax[i]
                else:
                    comp_dist = (m_hi[i] - o_lo[i] + margin) / (-ax[i])
                need = max(need, comp_dist)
    return round(float(need), 3)


def _sector_prism(inner: float, outer: float, start_deg: float, end_deg: float, z0: float, z1: float) -> CadPart:
    """Exact annular sector prism between `start_deg` and `end_deg` (degrees) from `z0` to `z1`."""
    lo_a, hi_a = min(float(start_deg), float(end_deg)), max(float(start_deg), float(end_deg))
    span = hi_a - lo_a
    step_deg = 4.0 if outer < 5.0 else 10.0
    steps = max(6, int(math.ceil(span / step_deg)))
    angles = [math.radians(lo_a + span * i / steps) for i in range(steps + 1)]
    pts = [(outer * math.cos(a), outer * math.sin(a)) for a in angles] + [
        (inner * math.cos(a), inner * math.sin(a)) for a in reversed(angles)
    ]
    return prism('_sector', pts, z1 - z0, (0, 0, (z0 + z1) / 2))


def _stadium_points(length: float, width: float, segments: int = 24) -> list[tuple[float, float]]:
    """2D stadium outline of total `length` (along u) and `width` (along v), centred at origin."""
    r = width / 2.0
    half = max(0.0, length / 2.0 - r)
    right = [
        (half + r * math.cos(-math.pi / 2 + math.pi * i / segments), r * math.sin(-math.pi / 2 + math.pi * i / segments))
        for i in range(segments + 1)
    ]
    left = [(-x, -y) for x, y in right]
    return right + left


def _double_d_prism(name: str, radius: float, flat_half: float, length: float, z_center: float = 0.0) -> CadPart:
    """Extrude a double-D (cylinder with two parallel flats at y = +/- flat_half) centred at `z_center`."""
    if flat_half >= radius - 0.1:
        return cylinder(name, radius, length, (0, 0, z_center))
    cy = cylinder(name, radius, length, (0, 0, z_center))
    clip = box('_dd_clip', (radius * 2.4, flat_half * 2.0, length + 2.0), (0, 0, z_center))
    return common(cy, clip)


def _chamfered_bore(radius: float, z0: float, z1: float, lead: float = 0.45) -> CadPart:
    """Cylindrical bore cutter from `z0` to `z1` with 45-degree lead-in chamfers at both faces."""
    z_lo, z_hi = min(z0, z1), max(z0, z1)
    if lead <= 0 or z_hi - z_lo < 2 * lead + 1.0:
        return cylinder('_bore', radius, z_hi - z_lo + 4.0, (0, 0, (z_lo + z_hi) / 2.0))
    profile = [
        (0.0, z_lo - 1.5),
        (radius + lead + 1.5, z_lo - 1.5),
        (radius + lead, z_lo),
        (radius, z_lo + lead),
        (radius, z_hi - lead),
        (radius + lead, z_hi),
        (radius + lead + 1.5, z_hi + 1.5),
        (0.0, z_hi + 1.5),
    ]
    return lathe('_bore', profile)


def _build_bayonet_tip_and_cap(
    shaft_radius: float,
    z_cap: float,
    cap_name: str,
    cap_radius: float,
    clearance: float = 0.35,
    turn: float = 90.0,
    lug_height: float = 2.2,
    lip_height: float = 2.2,
    cap_wall: float = 2.4,
    lugs: int = 2,
    lug_angle: float = 34.0,
) -> tuple[list[CadPart], CadPart, float, float]:
    """Build local-frame cutters for a recessed-channel bayonet shaft tip AND the mating locking hub cap.

    The shaft outer radius is `shaft_radius` extending up to `z_tip` (returned). The cap sits from
    `z_cap` to `z_outer` with an outer flange of `cap_radius` and `lugs` inward-pointing bayonet lugs
    at `turn` degrees from the axial entry channels (at 0, 180, ... degrees).

    Returns `(shaft_cutters, cap_part, z_tip, z_outer)` in local frame (unplaced).
    """
    r = float(shaft_radius)
    c = float(clearance)
    if r < 2.8:
        raise ValueError(f'bayonet tip: shaft radius {r:.2f} mm is too small (need >= 2.8 mm / diameter >= 5.6 mm)')
    lug_depth = min(1.8, max(1.35, r * 0.42))
    r_floor = r - lug_depth
    if r_floor < 1.35:
        raise ValueError(f'bayonet tip: shaft core radius {r_floor:.2f} mm would be too thin')
    r_sleeve = r + c
    r_lug_in = r_floor + c
    if r - r_lug_in < 0.85:
        raise ValueError('bayonet tip: radial lug engagement would be under 0.85 mm; increase shaft diameter or reduce clearance')
    r_outer = max(float(cap_radius), r_sleeve + 1.8)

    z_ch_lo = z_cap + 0.35
    # Leave extra floor clearance under the lugs so under gravity the cap rests flat on the shaft top face (z_tip),
    # never across the recessed channel rim.
    z_lug_lo = z_ch_lo + c + 0.35
    z_lug_hi = z_lug_lo + lug_height
    z_ch_hi = z_lug_hi + c
    z_tip = z_ch_hi + lip_height
    z_roof = z_tip + c
    z_outer = z_roof + cap_wall

    # Angular pad guarantees exact chordal clearance >= c even at the inner channel floor radius.
    deg_pad = math.degrees(math.asin(min(0.85, (c + 0.08) / r_floor)))
    entry_half = lug_angle / 2.0 + deg_pad
    if abs(turn) < lug_angle + 2.0 * deg_pad + 12.0:
        raise ValueError(f'bayonet tip: turn {turn} deg is too small for lug_angle {lug_angle} deg at radius {r:.1f}')

    cutters: list[CadPart] = []
    # Cap body: flat outer face at z_outer, flanged sleeve down to z_cap.
    cap = cylinder(cap_name, r_outer, z_outer - z_cap, (0, 0, (z_cap + z_outer) / 2.0))
    # Subtle chamfer on outer top rim for kid-friendly grip and clean printing.
    top_edges = [e for e in cap.shape.edges() if abs(e.bounding_box().min.Z - z_outer) < 0.05 and abs(e.bounding_box().max.Z - z_outer) < 0.05]
    if top_edges:
        chamfer(cap, min(0.6, cap_wall * 0.25), edges=top_edges)
    # Bore out clean cylindrical sleeve cavity up to z_roof.
    cut(cap, cylinder('_cap_bore', r_sleeve, z_roof - z_cap + 2.0, (0, 0, (z_cap - 2.0 + z_roof) / 2.0)))

    # 45-degree bevel on the outer perimeter rim of the channel ceiling/floor so lugs bear strictly on flat interior faces.
    bev = min(0.45, (r - r_lug_in) * 0.35)
    cutters.append(lathe('_ch_hi_bevel', [(r - bev, z_ch_hi), (r + 0.5, z_ch_hi), (r + 0.5, z_ch_hi + bev), (r, z_ch_hi + bev)]))
    cutters.append(lathe('_ch_lo_bevel', [(r - bev, z_ch_lo), (r + 0.5, z_ch_lo), (r + 0.5, z_ch_lo - bev), (r, z_ch_lo - bev)]))

    for idx in range(lugs):
        entry = 360.0 * idx / lugs
        locked = entry + turn
        # Axial entry channel from z_ch_lo through z_tip.
        cutters.append(_sector_prism(r_floor, r + 1.5, entry - entry_half, entry + entry_half, z_ch_lo, z_tip + 2.0))
        # Circumferential locking channel from entry to locked.
        lo_ang = min(entry, locked) - entry_half
        hi_ang = max(entry, locked) + entry_half
        cutters.append(_sector_prism(r_floor, r + 1.5, lo_ang, hi_ang, z_ch_lo, z_ch_hi))
        # Inward-pointing bayonet lug fused inside the cap sleeve.
        lug = _sector_prism(r_lug_in, r_sleeve + 0.8, locked - lug_angle / 2.0, locked + lug_angle / 2.0, z_lug_lo, z_lug_hi)
        join(cap, lug)

    return cutters, cap, z_tip, z_outer


def _build_keyed_snap_tip_and_cap(
    shaft_radius: float,
    z_cap: float,
    cap_name: str,
    cap_radius: float,
    cap_thick: float = 3.6,
    clearance: float = 0.35,
    barb: float = 0.85,
    head_height: float = 2.2,
) -> tuple[CadPart, CadPart, CadPart, float, float]:
    """Build local-frame keyed split-barbed snap tip, compliance slot cutter, and keyed retainer cap.

    The cap has a deep double-D bore (flats at y = +/- flat_half) that locks rotationally onto the shaft
    tip and snaps behind bevelled +/-X barbs (`retainer='snap'`, full 6-DOF retention, never unscrews on
    rotating or sliding shafts). The barb head is clipped to the double-D flat width so mating wheels or
    guide bores slide cleanly over the tip during disassembly.

    Returns `(tip_solid, slot_cutter, cap_part, z_tip, snap_dist)` in local frame (unplaced).
    """
    r = float(shaft_radius)
    c = float(clearance)
    b = float(barb)
    if r < 2.1:
        raise ValueError(f'keyed snap tip: shaft radius {r:.2f} mm is too small (need >= 2.1 mm)')
    if not (0.65 <= b <= 1.5):
        raise ValueError(f'keyed snap tip: barb {b:.2f} mm must be in 0.65..1.5 mm')

    flat_half = max(1.25, r * 0.58)
    bore_r = r + c
    head_r = bore_r + b
    r_outer = max(float(cap_radius), head_r + 1.4)

    z_cap_bot = float(z_cap)
    z_cap_top = z_cap_bot + float(cap_thick)
    z_barb_bot = z_cap_top + c
    z_tip = z_barb_bot + float(head_height)

    # Keyed deep double-D shaft stem extending from z_cap_bot - 1.5 to z_barb_bot + 0.5.
    tip_solid = _double_d_prism('_snap_stub', r, flat_half, (z_barb_bot + 0.5) - (z_cap_bot - 1.5), (z_cap_bot - 1.5 + z_barb_bot + 0.5) / 2.0)
    lead_z = max(0.7, head_height - 0.9)
    # Bevelled catch shoulder at z_barb_bot clipped to |y| <= flat_half so barbs protrude along +/-X only.
    barb_head = lathe('_snap_head', [
        (0.0, z_barb_bot),
        (head_r - 0.25, z_barb_bot),
        (head_r, z_barb_bot + 0.25),
        (head_r, z_barb_bot + head_height - lead_z),
        (r - 0.15, z_tip),
        (0.0, z_tip),
    ])
    common(barb_head, box('_bh_clip', (head_r * 2.4, flat_half * 2.0, head_height + 2.0), (0, 0, (z_barb_bot + z_tip) / 2.0)))
    join(tip_solid, barb_head)

    # Compliance slot along Y (|x| <= slot_w/2) so the +/-X barbed prongs flex inward during snap engagement.
    slot_w = max(1.2, r * 0.36)
    slot_len = head_height + cap_thick * 0.65
    slot_cutter = box('_snap_slot', (slot_w, head_r * 2.0 + 3.0, slot_len + 1.0), (0, 0, z_tip - (slot_len - 1.0) / 2.0))

    # Flat-printable keyed retainer cap with chamfered outer and inner edges.
    cap = cylinder(cap_name, r_outer, cap_thick, (0, 0, (z_cap_bot + z_cap_top) / 2.0))
    cut(cap, _double_d_prism('_snap_cap_bore', bore_r, flat_half + c, cap_thick + 4.0, (z_cap_bot + z_cap_top) / 2.0))
    rim_edges = [
        e for e in cap.shape.edges()
        if (abs(e.bounding_box().min.Z - z_cap_bot) < 0.05 and abs(e.bounding_box().max.Z - z_cap_bot) < 0.05)
        or (abs(e.bounding_box().min.Z - z_cap_top) < 0.05 and abs(e.bounding_box().max.Z - z_cap_top) < 0.05)
    ]
    if rim_edges:
        chamfer(cap, min(0.35, cap_thick * 0.12), edges=rim_edges)

    snap_dist = (z_tip - z_cap_bot) + 1.0
    return tip_solid, slot_cutter, cap, z_tip, snap_dist


# ---------------------------------------------------------------- assembly & disassembly helpers

def _part_name(part_or_name) -> str:
    if isinstance(part_or_name, CadPart):
        return part_or_name.name
    if isinstance(part_or_name, str):
        return part_or_name
    if hasattr(part_or_name, 'label') and part_or_name.label:
        return str(part_or_name.label)
    raise TypeError(f'Expected CadPart or part name string, got {type(part_or_name).__name__}')


def joint(
    name: str,
    kind: str,
    parent,
    child,
    axis='Z',
    pivot=(0, 0, 0),
    limits=(0, 0),
    control: str | None = None,
    retainer: str | None = None,
) -> dict:
    """Describe one physical connection: `fixed`, `revolute` (degrees), or `prismatic` (mm).

    `retainer` applies to `fixed` joints: `'rigid' | 'bayonet' | 'threaded' | 'snap' | 'friction'`.
    For `'bayonet'` and `'threaded'`, `axis` (and optional `pivot`) record the unlock/unscrew axis.
    """
    if kind not in ('fixed', 'revolute', 'prismatic'):
        raise ValueError("kind must be 'fixed', 'revolute', or 'prismatic'")
    record: dict = dict(id=str(name), kind=kind, parent=_part_name(parent), child=_part_name(child))
    if kind == 'fixed':
        if control is not None:
            raise ValueError(f'{name}: fixed joints cannot bind a movement control')
        if retainer is not None:
            if retainer not in _RETAINER_MODES:
                raise ValueError(f'{name}: retainer must be one of {_RETAINER_MODES}, got {retainer!r}')
            record['retainer'] = retainer
            if retainer in ('bayonet', 'threaded'):
                record['axis'] = [float(v) for v in direction(axis)]
                record['pivot'] = [float(v) for v in Vec3(pivot)]
    else:
        if retainer is not None:
            raise ValueError(f'{name}: retainer is only supported on fixed joints')
        low, high = float(limits[0]), float(limits[1])
        if not low <= 0.0 <= high or low == high:
            raise ValueError(f'{name}: limits must contain 0 (the saved pose) and be non-empty, got {limits}')
        record.update(
            axis=[float(v) for v in direction(axis)],
            pivot=[float(v) for v in Vec3(pivot)],
            range=[low, high],
        )
        if control:
            record['control'] = str(control)
    return record


def action_translate(delta) -> dict:
    """Rigid linear translation disassembly action in world mm."""
    v = Vec3(delta)
    return dict(kind='translate', delta=[v.x, v.y, v.z])


def action_rotate(pivot, axis, degrees: float, pitch_mm: float = 0.0) -> dict:
    """Rigid rotation (or helical screw when `pitch_mm != 0`) disassembly action."""
    p = Vec3(pivot)
    ax = direction(axis)
    deg = float(degrees)
    if deg == 0.0 or abs(deg) > 3600.0:
        raise ValueError(f'action_rotate: degrees must be nonzero and within +-3600, got {deg}')
    return dict(kind='rotate', pivot=[p.x, p.y, p.z], axis=[ax.x, ax.y, ax.z], degrees=deg, pitchMm=float(pitch_mm))


def action_snap(delta, max_interference_mm: float = 1.4, mate=None) -> dict:
    """Bounded elastic snap disengagement action along `delta` (world mm)."""
    v = Vec3(delta)
    limit = float(max_interference_mm)
    if not (0.0 < limit <= 2.5):
        raise ValueError(f'action_snap: max_interference_mm must be in (0, 2.5], got {limit}')
    act: dict = dict(kind='snap', delta=[v.x, v.y, v.z], maxInterferenceMm=limit)
    if mate is not None:
        act['mate'] = _part_name(mate)
    return act


def step_translate(part_ref, delta_or_path) -> dict:
    """Build a translation disassembly step for `part_ref`.

    Accepts either a single `[dx, dy, dz]` delta (emits v2 `actions`) or a sequence of waypoint
    offsets starting at `[0, 0, 0]` (emits legacy `path`).
    """
    name = _part_name(part_ref)
    if (
        isinstance(delta_or_path, (list, tuple))
        and len(delta_or_path) >= 2
        and hasattr(delta_or_path[0], '__len__')
    ):
        waypoints = [[float(c) for c in Vec3(pt)] for pt in delta_or_path]
        return dict(part=name, path=waypoints)
    return dict(part=name, actions=[action_translate(delta_or_path)])


def step_twist(part_ref, pivot, axis, degrees: float, pull=None, pitch_mm: float = 0.0, pre_translate=None) -> dict:
    """Build a twist/helical disassembly step (e.g. quarter-turn bayonet cap or threaded nut)."""
    name = _part_name(part_ref)
    actions: list[dict] = []
    if pre_translate is not None:
        actions.append(action_translate(pre_translate))
    actions.append(action_rotate(pivot, axis, degrees, pitch_mm=pitch_mm))
    if pull is not None:
        v = Vec3(pull)
        if v.length > 1e-6:
            actions.append(action_translate(v))
    return dict(part=name, actions=actions)


def step_snap(part_ref, snap_delta, max_interference_mm: float = 1.4, pull=None, mate=None) -> dict:
    """Build a bounded snap disengagement step followed by an optional rigid pull to clear the assembly."""
    name = _part_name(part_ref)
    actions = [action_snap(snap_delta, max_interference_mm=max_interference_mm, mate=mate)]
    if pull is not None:
        v = Vec3(pull)
        if v.length > 1e-6:
            actions.append(action_translate(v))
    return dict(part=name, actions=actions)


class RecipeResult(list):
    """Joint list returned by a separate-print recipe, carrying created parts, disassembly steps, and badge features.

    Acts as a plain list of joint dicts (so `joints=[res1, res2]` flattens naturally) while exposing
    `.parts`, `.joints`, `.steps`, `.features`, and named part shortcuts (e.g. `.cap`, `.pin`, `.stop`).
    """

    def __init__(self, joints=(), parts=(), steps=(), features=(), **named_parts):
        flat_joints = list(joints)
        super().__init__(flat_joints)
        self.joints: list[dict] = flat_joints
        self.parts: list[CadPart] = list(parts)
        self.steps: list[dict] = list(steps)
        self.features: list[dict] = list(features)
        self._named = dict(named_parts)
        for key, val in named_parts.items():
            setattr(self, key, val)


def _load_core_module(filename: str) -> dict:
    path = _HERE / filename
    if not path.is_file():
        raise FileNotFoundError(f'Required CAD core module is missing: {path}')
    return runpy.run_path(str(path))


def _record_badge_feature(kind: str, part_objs: Iterable[CadPart], joint_records: list[dict]) -> dict:
    """Record deterministic B-Rep construction evidence for `kind` via `cad/recipe_evidence.py` when present."""
    evidence_path = _HERE / 'recipe_evidence.py'
    parts_list = list(part_objs)
    if evidence_path.is_file():
        mod = runpy.run_path(str(evidence_path))
        by_name = {p.name: p.to_build123d() for p in parts_list}
        if 'make_feature' in mod:
            return mod['make_feature'](kind, by_name, joint_records)
    return dict(
        kind=kind,
        parts={p.name: None for p in parts_list},
        joints=[{k: j[k] for k in ('id', 'kind', 'parent', 'child')} for j in joint_records],
    )


def _flatten_inputs(joints_input):
    """Collect joint dicts, recipe-created parts, recipe disassembly steps, and badge features."""
    flat_joints: list[dict] = []
    extra_parts: list[CadPart] = []
    collected_steps: list[dict] = []
    collected_features: list[dict] = []

    def walk(item):
        if item is None:
            return
        if isinstance(item, RecipeResult):
            flat_joints.extend(item.joints)
            extra_parts.extend(item.parts)
            collected_steps.extend(item.steps)
            collected_features.extend(item.features)
        elif isinstance(item, dict):
            flat_joints.append(item)
        elif isinstance(item, (list, tuple)):
            for sub in item:
                walk(sub)
        else:
            raise TypeError(f'Unsupported joint entry type: {type(item).__name__}')

    walk(joints_input)
    return flat_joints, extra_parts, collected_steps, collected_features


def _order_disassembly_steps(steps: list[dict], root_name: str, connections: list[dict]) -> list[dict]:
    """Order disassembly steps so child subtrees are removed before their parents while preserving recipe order."""
    if not steps:
        return []
    by_part: dict[str, dict] = {}
    original_index: dict[str, int] = {}
    for idx, st in enumerate(steps):
        p = st['part']
        if p in by_part:
            raise ValueError(f'Duplicate disassembly step for part {p!r}')
        by_part[p] = st
        original_index[p] = idx

    # Compute depth from root in the connection tree so deeper leaves remove before shallower parents.
    children_map: dict[str, list[str]] = {}
    for conn in connections:
        children_map.setdefault(conn['parent'], []).append(conn['child'])
    depth: dict[str, int] = {root_name: 0}
    queue = [root_name]
    while queue:
        cur = queue.pop(0)
        for ch in children_map.get(cur, ()):
            if ch not in depth:
                depth[ch] = depth[cur] + 1
                queue.append(ch)

    # Sort primarily by descending tree depth (leaves/caps first), breaking ties by original recipe order.
    ordered_names = sorted(by_part.keys(), key=lambda name: (-depth.get(name, 1), original_index[name]))
    return [by_part[name] for name in ordered_names]


def assembly(
    parts_list,
    root,
    joints=(),
    mode: str = 'separate',
    sequences=(),
    steps=None,
    controls=None,
) -> tuple[list[CadPart], dict, list[dict]]:
    """Build the normalized `(parts, assembly_dict, badge_features)` bundle from kit parts and recipe returns."""
    flat_joints, extra_parts, recipe_steps, recipe_features = _flatten_inputs(joints)

    resolved_parts: list[CadPart] = []
    seen_names: set[str] = set()

    def add_part(p):
        if isinstance(p, CadPart):
            if p.name not in seen_names:
                seen_names.add(p.name)
                resolved_parts.append(p)
        elif isinstance(p, b3d.Shape):
            label = getattr(p, 'label', None) or f'Part{len(resolved_parts) + 1}'
            if label not in seen_names:
                seen_names.add(label)
                resolved_parts.append(CadPart(label, p, color=tuple(p.color) if getattr(p, 'color', None) else None))
        else:
            raise TypeError(f'Expected CadPart or build123d Shape in parts, got {type(p).__name__}')

    if parts_list is None:
        for p in _SCENE.values():
            add_part(p)
    else:
        for p in parts_list:
            add_part(p)
    for p in extra_parts:
        add_part(p)

    if not resolved_parts:
        raise ValueError('publish: at least one part is required')

    root_name = _part_name(root) if root is not None else resolved_parts[0].name
    by_name = {p.name: p for p in resolved_parts}
    if root_name not in by_name:
        raise ValueError(f'publish: root part {root_name!r} is not in parts')

    ordered_parts = [by_name[root_name]] + [p for p in resolved_parts if p.name != root_name]

    # Collect standalone part features (e.g. living-hinge attached directly on a part).
    features = list(recipe_features)
    for p in ordered_parts:
        for feat in p.meta.get('_rumi_features', ()):
            if feat not in features:
                features.append(feat)

    if len(ordered_parts) == 1 and not flat_joints:
        mfg = dict(mode=mode or 'separate')
        asm: dict = dict(
            version=1,
            root=root_name,
            parts=[dict(id=root_name, mesh=root_name)],
            connections=[],
            sequences=[],
            manufacturing=mfg,
        )
        if controls is not None:
            asm['controls'] = controls
        return ordered_parts, asm, features

    children = {rec['child'] for rec in flat_joints}
    loose = [p.name for p in ordered_parts if p.name != root_name and p.name not in children]
    if loose:
        raise ValueError('These parts have no joint connecting them to the assembly: ' + ', '.join(loose))

    mfg_mode = mode
    asm = dict(
        version=1,
        root=root_name,
        parts=[dict(id=p.name, mesh=p.name) for p in ordered_parts],
        connections=flat_joints,
        sequences=[dict(item) for item in sequences],
        manufacturing=dict(mode=mfg_mode),
    )

    robot_mod = _load_core_module('robot_usd.py')
    robot_mod['require_separate_moving_parts'](asm)
    asm['manufacturing']['mode'] = mfg_mode or 'separate'

    final_steps = steps if steps is not None else (recipe_steps if recipe_steps else None)
    if final_steps is not None:
        ordered_steps = _order_disassembly_steps([dict(s) for s in final_steps], root_name, flat_joints)
        asm['manufacturing']['steps'] = ordered_steps

    if controls is not None:
        asm['controls'] = controls

    return ordered_parts, asm, features


def publish(
    directory,
    parts=None,
    root=None,
    joints=(),
    mode: str = 'separate',
    sequences=(),
    steps=None,
    controls=None,
    check: bool = True,
):
    """Publish parts as `directory/model.usda` + `model.step`, auto-collecting joints, steps, and badge features.

    `parts` may be a list of `CadPart`/build123d shapes (recipe-created parts from `joints` are
    automatically included) or `None` to publish all active parts from `K.start()`.
    """
    # Convenience: allow publish(directory, root_part, joints=...) if a single part is passed as `parts` and `root` is None.
    if isinstance(parts, (CadPart, b3d.Shape)) and root is None:
        root = parts
        parts = None

    ordered_parts, asm, features = assembly(
        parts, root, joints=joints, mode=mode, sequences=sequences, steps=steps, controls=controls
    )
    b3d_parts = [p.to_build123d() for p in ordered_parts]
    cad_mod = _load_core_module('rumi_cad.py')
    return cad_mod['publish'](
        str(directory),
        b3d_parts,
        assembly=asm,
        check=check,
        features=features if features else None,
    )


# ---------------------------------------------------------------- load joint recipes

def _load_recipes() -> dict:
    namespace = dict(globals())
    recipes: dict = {}
    joints_dir = _HERE / 'joints'
    if joints_dir.is_dir():
        # Load wheels first so mechanisms/hinges can reuse shared recipe functions cleanly.
        order = ['wheels.py', 'hinges.py', 'sliders.py', 'fasteners.py', 'mechanisms.py']
        paths = [joints_dir / f for f in order if (joints_dir / f).is_file()]
        for extra in sorted(joints_dir.glob('*.py')):
            if extra not in paths:
                paths.append(extra)
        for path in paths:
            loaded = runpy.run_path(str(path), init_globals=namespace)
            for key, value in loaded.items():
                if callable(value) and not key.startswith('_') and key not in namespace:
                    recipes[key] = value
                    namespace[key] = value
    return recipes


globals().update(_load_recipes())
