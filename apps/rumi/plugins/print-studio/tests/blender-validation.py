"""Run with Blender --background --python-exit-code 1 --python tests/blender-validation.py."""
import json
from pathlib import Path
import runpy
import tempfile

import bpy

helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'blender/validate.py'))
settings = dict(minimumThicknessMm=1, degenerateThreshold=.000001, overhangDegrees=45,
                sharpDegrees=160, distortionDegrees=45, minimumClearanceMm=.2)
transform = dict(scale=1, rotate=dict(x=0, y=0, z=0), position=dict(x=0, y=0, z=0))

with tempfile.TemporaryDirectory(prefix='rumi-toolbox-test-') as directory:
    def check(kind, extension='stl'):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        bpy.ops.mesh.primitive_cube_add(size=10 if extension == 'stl' else .01)
        if kind in ('parented', 'sheared', 'mirrored'):
            obj = bpy.context.object
            obj.scale = (1000, 2000, 3000)
            frame = bpy.data.objects.new('export-frame', None)
            bpy.context.collection.objects.link(frame)
            frame.scale = (.001, .001, .001)
            frame.rotation_euler.z = 1.5707963267948966
            frame.location = (.02, .03, .04)
            obj.parent = frame
            if kind == 'mirrored':
                frame.scale.x = -.001
            if kind == 'sheared':
                obj.scale = (1000, 1000, 1000)
                obj.rotation_euler.z = .7853981633974483
                frame.scale = (.001, .002, .003)
                frame.rotation_euler.z = 0
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
        names = ['model'] if extension == 'stl' else [obj.name for obj in bpy.context.scene.objects if obj.type == 'MESH']
        assembly = dict(version=1, root=names[0], parts=[dict(id=name, mesh=name) for name in names],
                        connections=[], manufacturing=dict(mode='print-in-place'))
        try:
            report = helper['validate'](dict(input=path, settings=settings, transform=transform, volume=None,
                mechanicsOutput=str(Path(directory) / 'bodies.json'), assembly=assembly))
            bodies = json.loads((Path(directory) / 'bodies.json').read_text())['bodies']
            points = [point for body in bodies for point in body['vertices']]
            for index, axis in enumerate('xyz'):
                assert abs(max(p[index] for p in points)-min(p[index] for p in points)
                           - report['dimensions'][axis]) < .001, (axis, report)
            assert abs(min(p[2] for p in points)) < .001
            return report
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
    parented = check('parented', 'glb')
    assert all(abs(parented['dimensions'][axis]-expected) < .001
               for axis, expected in zip('xyz', (20, 10, 30))), parented
    assert not any(c['count'] for c in parented['checks'] if c['severity'] == 'error'), parented
    mirrored = check('mirrored', 'glb')
    assert not any(c['count'] for c in mirrored['checks'] if c['severity'] == 'error'), mirrored
    sheared = check('sheared', 'glb')
    assert all(abs(sheared['dimensions'][axis]-expected) < .001
               for axis, expected in zip('xyz', (10*2**.5, 20*2**.5, 30))), sheared

    def clearance(gap_mm, mode='print-in-place', connections=()):
        """Two 10 mm cubes `gap_mm` apart along x, exported as GLB metres."""
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        bpy.ops.mesh.primitive_cube_add(size=.01, location=(0, 0, 0))
        first = bpy.context.object.name
        bpy.ops.mesh.primitive_cube_add(size=.01, location=((10 + gap_mm) / 1000, 0, 0))
        second = bpy.context.object.name
        path = str(Path(directory) / 'clearance.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB')
        assembly = dict(version=1, root=first, parts=[dict(id=first, mesh=first), dict(id=second, mesh=second)],
                        connections=[dict(parent=first, child=second, kind=kind) for kind in connections],
                        manufacturing=dict(mode=mode))
        try:
            report = helper['validate'](dict(input=path, settings=settings, transform=transform, volume=None,
                mechanicsOutput=str(Path(directory) / 'clearance.json'), assembly=assembly))
        finally:
            helper['toolbox'].unregister()
        return first, second, next(c for c in report['checks'] if c['code'] == 'insufficient_clearance')

    first, second, tight = clearance(.1)
    assert tight['severity'] == 'error' and tight['count'] == 1, tight
    pair = tight['details']['pairs'][0]
    assert {pair['a'], pair['b']} == {first, second} and abs(pair['gapMm'] - .1) < .02, tight
    assert tight['details']['minimumClearanceMm'] == .2 and len(tight['details']['pairs']) == 1, tight
    assert clearance(.4)[2]['count'] == 0
    assert clearance(0, connections=['fixed'])[2]['count'] == 0
    loose = clearance(.1, 'separate')[2]
    assert loose['severity'] == 'error' and loose['count'] == 1, loose
    overlapping = clearance(-1)[2]
    assert overlapping['count'] == 1 and overlapping['details']['pairs'][0]['gapMm'] == 0, overlapping
print('BLENDER_VALIDATION_OK: closed/open/intersecting solids, GLB units, and part clearance')
