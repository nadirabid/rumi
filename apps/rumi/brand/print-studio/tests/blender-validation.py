"""Run with Blender --background --python-exit-code 1 --python tests/blender-validation.py."""
import json
from pathlib import Path
import runpy
import tempfile

import bpy

helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'blender/validate.py'))
settings = dict(minimumThicknessMm=1, degenerateThreshold=.000001, overhangDegrees=45,
                sharpDegrees=160, distortionDegrees=45)
transform = dict(scale=1, rotate=dict(x=0, y=0, z=0), position=dict(x=0, y=0, z=0))

with tempfile.TemporaryDirectory(prefix='rumi-toolbox-test-') as directory:
    def check(kind, extension='stl'):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        bpy.ops.mesh.primitive_cube_add(size=10 if extension == 'stl' else .01)
        if kind == 'open':
            obj = bpy.context.object
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[0]], context='FACES')
            bm.to_mesh(obj.data)
            bm.free()
        if kind == 'overlap':
            bpy.ops.mesh.primitive_cube_add(size=10, location=(5, 5, 5))
        path = str(Path(directory) / ('model.'+extension))
        if extension == 'stl':
            bpy.ops.wm.stl_export(filepath=path)
        else:
            bpy.ops.export_scene.gltf(filepath=path, export_format='GLB')
        try:
            return helper['validate'](dict(input=path, settings=settings, transform=transform, volume=None))
        finally:
            helper['toolbox'].unregister()

    cube = check('closed')
    assert cube['status'] in ['passed', 'review'] and cube['printReady'] is False
    assert not any(c['count'] for c in cube['checks'] if c['severity'] == 'error'), cube
    assert check('open')['status'] == 'needs_repair'
    overlap = check('overlap')
    assert next(c for c in overlap['checks'] if c['code'] == 'intersecting_faces')['count'] > 0
    glb = check('closed', 'glb')
    assert all(abs(v-10) < .001 for v in glb['dimensions'].values()), glb
print('BLENDER_VALIDATION_OK: closed/open/intersecting solids and GLB units')
