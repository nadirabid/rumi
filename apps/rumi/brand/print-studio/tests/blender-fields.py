"""Verify frozen field application, transform handling and stale-source rejection."""
import bpy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
from mathutils import Vector

helper = runpy.run_path(sys.argv[sys.argv.index('--')+1])
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=.004, location=(.001, 0, 0))
obj = bpy.context.object
obj.name = 'Shell'
obj.scale = (1, .5, 1.2)
bpy.context.view_layer.update()
points = [(obj.matrix_world @ v.co)*1000 for v in obj.data.vertices]
offsets = [0]*81
offsets[41] = 5
field = dict(key='crown', origin=[-10]*3, spacing=[10]*3, dimensions=[3]*3, offsets=offsets)
fields = runpy.run_path(str(Path(sys.argv[sys.argv.index('--')+1]).with_name('fields.py')))
with tempfile.TemporaryDirectory() as directory:
    source = Path(directory)/'model.usda'
    source.write_text('#usda 1.0\n')
    recipe = dict(version=1, frozen=True, operation='fields', fields=[field], values={'crown': .7}, parts=['Shell'], source=str(source), sourceHash=hashlib.sha256(source.read_bytes()).hexdigest())
    path = Path(directory)/'recipe.json'
    path.write_text(json.dumps(recipe))
    expected = [fields['field_point'](p, recipe) for p in points]
    helper['apply_shape_controls'](str(path))
    for vertex, point in zip(obj.data.vertices, expected):
        assert ((obj.matrix_world @ vertex.co)*1000-point).length < .00001
    before = [v.co.copy() for v in obj.data.vertices]
    source.write_text('changed')
    try:
        helper['apply_shape_controls'](str(path))
        raise AssertionError('Stale source accepted')
    except ValueError as error:
        assert 'changed' in str(error)
    assert all((a-v.co).length == 0 for a,v in zip(before,obj.data.vertices))
print('Field save agrees with preview coordinates; stale source rejected without mutation')
