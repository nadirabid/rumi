"""Headless Blender cut regression: hollow cap, transforms, source guard and empty-cut recovery.

Run Blender --background --python-exit-code 1 --python this_file -- helper_path.
"""
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile

import bpy
import bmesh
from mathutils import Matrix, Vector
from math import cos, sin, tau

helper = runpy.run_path(sys.argv[sys.argv.index('--') + 1])
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
vertices = []
count = 64
for radius, height in [(.05, -.06), (.05, .06), (.035, -.06), (.035, .06)]:
    vertices.extend([(radius*cos(tau*i/count), radius*sin(tau*i/count), height) for i in range(count)])
faces = []
for i in range(count):
    j = (i + 1) % count
    faces.extend([(i, j, count+j, count+i), (2*count+j, 2*count+i, 3*count+i, 3*count+j),
                  (count+i, count+j, 3*count+j, 3*count+i), (j, i, 2*count+i, 2*count+j)])
original = bpy.data.meshes.new('Tube')
original.from_pydata(vertices, [], faces)
obj = bpy.data.objects.new('Shell', original)
bpy.context.scene.collection.objects.link(obj)
obj.matrix_world = Matrix.Translation((.01, -.02, .03)) @ Matrix.Rotation(.15, 4, 'Y') @ Matrix.Diagonal((1.2, .8, 1.1, 1))
with tempfile.TemporaryDirectory(prefix='rumi-cut-') as directory:
    source = Path(directory) / 'model.glb'
    source.write_bytes(b'cut-regression-source')
    recipe = dict(version=1, frozen=True, operation='cut', center=[0, 0, 30], radii=[100, 100, 100],
                  direction=[0, 0, 1], limit=80, parts=['Shell'], source=str(source),
                  sourceHash=hashlib.sha256(source.read_bytes()).hexdigest(),
                  values=dict(amount=.5, spread=.55, angle=.625, peakX=.5, peakY=.5, falloff=.5))
    path = Path(directory) / 'recipe.json'
    path.write_text(json.dumps(recipe))
    helper['apply_shape_controls'](path)
    assert len(obj.data.polygons) > 0 and obj.data != original
    normal, point = helper['cut_plane'](recipe)
    world = [obj.matrix_world @ vertex.co * 1000 for vertex in obj.data.vertices]
    distances = [normal.dot(vertex-point) for vertex in world]
    assert min(distances) > -.001, min(distances)
    assert sum(abs(distance) < .001 for distance in distances) >= count * 2
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        assert all(edge.is_manifold for edge in bm.edges), 'Cut leaves an open boundary'
        cap_faces = [face for face in bm.faces if all(abs(normal.dot((obj.matrix_world @ vertex.co)*1000-point)) < .001 for vertex in face.verts)]
        assert cap_faces, 'Missing cut cap'
        # The centre of the bore stays empty; a filled disk would cross the axis.
        for face in cap_faces:
            center = face.calc_center_median()
            assert center.x*center.x + center.y*center.y > .025**2, 'Cap fills the tube bore'
    finally:
        bm.free()
    saved = obj.data
    source.write_bytes(b'changed')
    try:
        helper['apply_shape_controls'](path)
        raise AssertionError('Changed source accepted')
    except ValueError as error:
        assert 'Source model changed' in str(error)
    assert obj.data == saved
    source.write_bytes(b'cut-regression-source')
    recipe['center'] = [0, 0, 1000]
    path.write_text(json.dumps(recipe))
    try:
        helper['apply_shape_controls'](path)
        raise AssertionError('Entire model removal accepted')
    except ValueError as error:
        assert 'entire model' in str(error)
    assert obj.data == saved
    assert not any(item.name.startswith('RumiCut') for item in bpy.data.objects)
print('CUT_REGRESSION_OK: transformed hollow shell capped, bore open, source guard and empty-cut recovery')
