"""Generate small solid and separately assembleable slider fixtures using the bundled USD publisher."""
import importlib.util
from pathlib import Path
import runpy
import sys
import bpy

output, helper, fixtures_path = sys.argv[sys.argv.index('--') + 1:]
spec = importlib.util.spec_from_file_location('physical_fixtures', fixtures_path)
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
publish = runpy.run_path(helper)['publish']
robot = runpy.run_path(str(Path(helper).with_name('robot_usd.py')))
slider = fixtures.slider()
# Separate sliding parts have a clear insertion route and production-sized clearance and walls.
for vertex in slider['bodies'][0]['vertices']:
    vertex[0] *= 2
    for axis in (1, 2):
        radius = abs(vertex[axis])
        vertex[axis] *= (5.3 if abs(radius - 2.05) < .001 else 6.8) / radius
for vertex in slider['bodies'][1]['vertices']:
    vertex[0] *= 4
    vertex[1] *= 2.5
    vertex[2] *= 2.5
slider['assembly']['manufacturing'] = dict(mode='separate', steps=[dict(part='moving', path=[[0,0,0], [40,0,0]])])
solid = fixtures.assembly([fixtures.box('block', [0, 0, 10], [10, 10, 10])], 'block', [])
for name, request in [('solid', solid), ('slider', slider)]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for body in request['bodies']:
        mesh = bpy.data.meshes.new(body['id'])
        mesh.from_pydata([[v / 1000 for v in point] for point in body['vertices']], [], body['triangles'])
        mesh.update()
        bpy.context.collection.objects.link(bpy.data.objects.new(body['id'], mesh))
    publish(str(Path(output) / name), configure_robot=lambda stage: robot['migrate_assembly'](stage, request['assembly']))
print('VALIDATION_MODELS_READY')
