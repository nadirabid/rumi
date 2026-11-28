"""Revision-bound construction evidence for Print Studio B-Rep recipes.

Tracks deterministic part + joint signatures so mechanical badges only match when
the constructed B-Rep geometry and declared assembly joints remain intact at publish time.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path
from typing import Any

import runpy

_HERE = Path(__file__).resolve().parent
_make_valid_identifier = runpy.run_path(str(_HERE / 'robot_usd.py'))['make_valid_identifier']


def _unwrap_shape(shape: Any) -> Any:
    """Return the underlying OCP TopoDS_Shape from a build123d Shape or raw TopoDS_Shape."""
    return shape.wrapped if hasattr(shape, 'wrapped') else shape


def shape_signature(shape: Any) -> str:
    """Return a deterministic SHA-256 signature of a B-Rep shape's geometry and placement."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE, TopAbs_VERTEX
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    wrapped = _unwrap_shape(shape)
    digest = hashlib.sha256()

    # Global volume + center of mass
    vol_props = GProp_GProps()
    BRepGProp.VolumeProperties_s(wrapped, vol_props)
    vol = round(float(vol_props.Mass()), 6)
    com = vol_props.CentreOfMass()
    digest.update(struct.pack('<4d', vol, round(com.X(), 6), round(com.Y(), 6), round(com.Z(), 6)))

    # Tight bounding box
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(wrapped, box, False, False)
    if not box.IsVoid():
        cmin = box.CornerMin()
        cmax = box.CornerMax()
        digest.update(struct.pack(
            '<6d',
            round(float(cmin.X()), 6), round(float(cmin.Y()), 6), round(float(cmin.Z()), 6),
            round(float(cmax.X()), 6), round(float(cmax.Y()), 6), round(float(cmax.Z()), 6),
        ))

    # Order-independent face invariants: (surface_type, area, com_x, com_y, com_z)
    faces: list[tuple[int, float, float, float, float]] = []
    fexp = TopExp_Explorer(wrapped, TopAbs_FACE)
    while fexp.More():
        face = TopoDS.Face(fexp.Current())
        surf_props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, surf_props)
        fcom = surf_props.CentreOfMass()
        stype = int(BRepAdaptor_Surface(face).GetType().value)
        faces.append((
            stype,
            round(float(surf_props.Mass()), 5),
            round(float(fcom.X()), 5),
            round(float(fcom.Y()), 5),
            round(float(fcom.Z()), 5),
        ))
        fexp.Next()
    faces.sort()
    digest.update(struct.pack('<I', len(faces)))
    for item in faces:
        digest.update(struct.pack('<i4d', *item))

    # Order-independent deduplicated vertex positions
    verts: set[tuple[float, float, float]] = set()
    vexp = TopExp_Explorer(wrapped, TopAbs_VERTEX)
    while vexp.More():
        pt = BRep_Tool.Pnt_s(TopoDS.Vertex(vexp.Current()))
        verts.add((round(float(pt.X()), 5), round(float(pt.Y()), 5), round(float(pt.Z()), 5)))
        vexp.Next()
    sorted_verts = sorted(verts)
    digest.update(struct.pack('<I', len(sorted_verts)))
    for vx, vy, vz in sorted_verts:
        digest.update(struct.pack('<3d', vx, vy, vz))

    return digest.hexdigest()


def _is_shape(obj: Any) -> bool:
    """Return True when `obj` is a build123d Shape or raw OCP TopoDS_Shape."""
    return hasattr(obj, 'wrapped') or type(obj).__name__.startswith('TopoDS_')


def make_feature(kind: str, parts_by_name: dict[str, Any], joints: list[dict[str, Any]] | tuple[dict[str, Any], ...] = ()) -> dict[str, Any]:
    """Create a standalone feature evidence record from named shapes and joint dicts."""
    parts = {name: shape_signature(shape) for name, shape in parts_by_name.items()}
    joint_records = [
        {key: edge[key] for key in ('id', 'kind', 'parent', 'child')}
        for edge in joints
    ]
    return {'kind': kind, 'parts': parts, 'joints': joint_records}


def record_feature(kind: str, result: Any, parts_by_name: dict[str, Any] | None = None) -> Any:
    """Attach construction evidence for the exact parts and joints a recipe produced.

    Supports:
    - Single build123d Shape (e.g. living-hinge panel)
    - Recipe bundle dict with `'parts'` and `'joints'`
    - Single joint dict or list/tuple of joint dicts (resolved against `parts_by_name`)
    """
    if _is_shape(result):
        name = getattr(result, 'label', '') or 'Model'
        record = {'kind': kind, 'parts': {name: shape_signature(result)}, 'joints': []}
        existing = getattr(result, '_rumi_features', None)
        if not isinstance(existing, list):
            existing = []
            setattr(result, '_rumi_features', existing)
        existing.append(record)
        return result

    parts_map: dict[str, Any] = dict(parts_by_name or {})
    if isinstance(result, dict) and 'joints' in result:
        connections = list(result.get('joints') or ())
        for part in result.get('parts') or ():
            if _is_shape(part) and getattr(part, 'label', None):
                parts_map[part.label] = part
    else:
        connections = list(result) if isinstance(result, (list, tuple)) else [result]

    if not connections:
        return result

    names = list(dict.fromkeys(
        name for edge in connections for name in (edge['parent'], edge['child'])
    ))
    missing = [name for name in names if name not in parts_map]
    if missing:
        raise KeyError(f'record_feature({kind!r}): missing shapes for parts: {", ".join(missing)}')

    owner = parts_map[connections[0]['child']]
    parts = {name: shape_signature(parts_map[name]) for name in names}
    joints = [{key: edge[key] for key in ('id', 'kind', 'parent', 'child')} for edge in connections]
    record = {'kind': kind, 'parts': parts, 'joints': joints}

    existing = getattr(owner, '_rumi_features', None)
    if not isinstance(existing, list):
        existing = []
        setattr(owner, '_rumi_features', existing)
    existing.append(record)
    return result


def published_features(
    parts_by_name: dict[str, Any],
    assembly: dict[str, Any],
    extra_features: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return constructed features whose involved parts and declared joints still match exactly."""
    mesh_names = {part['mesh'] for part in assembly.get('parts', ())}
    connections = {
        edge['id']: (edge['kind'], edge['parent'], edge['child'])
        for edge in assembly.get('connections', ())
    }
    by_sanitized = {_make_valid_identifier(name): shape for name, shape in parts_by_name.items()}

    candidates: list[dict[str, Any]] = []
    for shape in parts_by_name.values():
        attached = getattr(shape, '_rumi_features', None)
        if isinstance(attached, list):
            candidates.extend(attached)
        elif isinstance(attached, dict):
            for kind, saved in attached.items():
                if isinstance(saved, dict):
                    candidates.append({'kind': kind, **saved})
    if extra_features:
        candidates.extend(extra_features)

    signatures: dict[str, str] = {}

    def current_signature(name: str, sanitized: str) -> str | None:
        part = parts_by_name.get(name)
        if part is None:
            part = by_sanitized.get(sanitized)
        if part is None or sanitized not in mesh_names:
            return None
        if sanitized not in signatures:
            signatures[sanitized] = shape_signature(part)
        return signatures[sanitized]

    # When multiple recipes attach sequentially to the same parent part (e.g., 4 wheels on Body,
    # or a chained Arm that is a hinge child and then an axle parent), each recipe mutates that
    # parent so earlier snapshots of the parent differ from its final published signature.
    # A parent part's earlier snapshots stay valid iff its final published signature matches at
    # least one valid joint-backed recipe referencing it as a parent (proving no unrecorded
    # post-recipe modification tampered with it).
    parent_recorded_sigs: dict[str, set[str]] = {}
    for saved in candidates:
        try:
            saved_parts = saved['parts']
            saved_joints = saved.get('joints', [])
            if not isinstance(saved_parts, dict) or not isinstance(saved_joints, list) or not saved_joints:
                continue
            parent_ids: set[str] = set()
            joints_ok = True
            for edge in saved_joints:
                joint_id = _make_valid_identifier(edge['id'])
                parent_id = _make_valid_identifier(edge['parent'])
                child_id = _make_valid_identifier(edge['child'])
                if connections.get(joint_id) != (edge['kind'], parent_id, child_id):
                    joints_ok = False
                    break
                parent_ids.add(parent_id)
            if not joints_ok:
                continue
            for name, expected in saved_parts.items():
                sanitized = _make_valid_identifier(name)
                if sanitized in parent_ids and isinstance(expected, str):
                    parent_recorded_sigs.setdefault(sanitized, set()).add(expected)
        except (KeyError, TypeError, ValueError):
            continue

    verified_shared_parents: set[str] = set()
    for sanitized, recorded_sigs in parent_recorded_sigs.items():
        actual = current_signature(sanitized, sanitized)
        if actual is not None and actual in recorded_sigs:
            verified_shared_parents.add(sanitized)

    features: list[dict[str, Any]] = []
    seen: set[str] = set()

    for saved in candidates:
        try:
            kind = saved['kind']
            saved_parts = saved['parts']
            saved_joints = saved.get('joints', [])
            if not isinstance(kind, str) or not kind or not isinstance(saved_parts, dict) or not isinstance(saved_joints, list):
                continue

            verified_parts: list[str] = []
            for name, expected in saved_parts.items():
                sanitized = _make_valid_identifier(name)
                actual = current_signature(name, sanitized)
                if actual is None:
                    break
                if actual != expected:
                    if not (saved_joints and sanitized in verified_shared_parents):
                        break
                verified_parts.append(sanitized)
            else:
                verified_joints: list[str] = []
                for edge in saved_joints:
                    joint_id = _make_valid_identifier(edge['id'])
                    endpoints = (
                        edge['kind'],
                        _make_valid_identifier(edge['parent']),
                        _make_valid_identifier(edge['child']),
                    )
                    if connections.get(joint_id) != endpoints:
                        break
                    verified_joints.append(joint_id)
                else:
                    if verified_parts:
                        dedup_key = json.dumps([kind, verified_parts, verified_joints], sort_keys=True)
                        if dedup_key not in seen:
                            seen.add(dedup_key)
                            features.append({'kind': kind, 'parts': verified_parts, 'joints': verified_joints})
        except (KeyError, TypeError, ValueError):
            continue

    return features
