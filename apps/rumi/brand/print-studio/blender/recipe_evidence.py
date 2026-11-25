"""Revision-bound construction evidence from Print Studio recipes."""
from array import array
import hashlib
import json

import bpy
from pxr import Tf


def mesh_signature(obj):
    """Identify the part's local geometry and assembled transform across saves."""
    mesh = obj.data
    digest = hashlib.sha256()
    for items, field, width, dtype in ((mesh.vertices, 'co', 3, 'f'), (mesh.loops, 'vertex_index', 1, 'i'),
                                       (mesh.polygons, 'loop_total', 1, 'i')):
        values = array(dtype, [0]) * (len(items) * width)
        items.foreach_get(field, values)
        digest.update(values)
    digest.update(array('d', (v for row in obj.matrix_world for v in row)))
    return digest.hexdigest()


def record_feature(kind, result):
    """Remember successful recipe construction for the exact parts and joints it produced."""
    if isinstance(result, bpy.types.Object):
        owner, joints, names = result, [], [result.name]
    else:
        connections = result if isinstance(result, list) else [result]
        owner = bpy.data.objects[connections[0]['child']]
        names = list(dict.fromkeys(name for edge in connections for name in (edge['parent'], edge['child'])))
        joints = [{key: edge[key] for key in ('id', 'kind', 'parent', 'child')} for edge in connections]
    parts = {name: mesh_signature(bpy.data.objects[name]) for name in names}
    owner['rumi_feature_' + kind] = json.dumps(dict(parts=parts, joints=joints))
    return result


def published_features(objects, assembly):
    """Include constructed features only while all involved meshes and declared joints still match."""
    objects_by_name = {obj.name: obj for obj in objects}
    mesh_names = {part['mesh'] for part in assembly['parts']}
    connections = {edge['id']: (edge['kind'], edge['parent'], edge['child']) for edge in assembly['connections']}
    signatures = {}
    features = []
    for obj in objects:
        for key in obj.keys():
            if not key.startswith('rumi_feature_'):
                continue
            try:
                saved = json.loads(obj[key])
                if not isinstance(saved['parts'], dict) or not isinstance(saved['joints'], list):
                    continue
                parts = []
                for name, expected in saved['parts'].items():
                    part = objects_by_name.get(name)
                    if part is None or len(part.modifiers) or part.data.shape_keys or Tf.MakeValidIdentifier(name) not in mesh_names:
                        break
                    if name not in signatures:
                        signatures[name] = mesh_signature(part)
                    if signatures[name] != expected:
                        break
                    parts.append(Tf.MakeValidIdentifier(name))
                else:
                    joints = []
                    for edge in saved['joints']:
                        joint_id = Tf.MakeValidIdentifier(edge['id'])
                        endpoints = (edge['kind'], Tf.MakeValidIdentifier(edge['parent']), Tf.MakeValidIdentifier(edge['child']))
                        if connections.get(joint_id) != endpoints:
                            break
                        joints.append(joint_id)
                    else:
                        if parts:
                            features.append(dict(kind=key[len('rumi_feature_'):], parts=parts, joints=joints))
            except (KeyError, TypeError, ValueError):
                continue
    return features
