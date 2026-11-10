"""Generate small solid and captive-wheel fixtures using the bundled USD publisher."""
import importlib.util
import math
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
wheel = fixtures.wheel(play=.5)
# Keep tessellated radial clearance above the production 0.2 mm minimum.
for vertex in wheel['bodies'][0]['vertices']:
    radius = math.hypot(vertex[0], vertex[1])
    if abs(radius - 3.8) < .001:
        vertex[0] *= 3.5 / radius
        vertex[1] *= 3.5 / radius
wheel['assembly']['connections'][0]['range'] = [-90, 90]
solid = fixtures.assembly([fixtures.box('block', [0, 0, 10], [10, 10, 10])], 'block', [])
for name, request in [('solid', solid), ('wheel', wheel)]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for body in request['bodies']:
        mesh = bpy.data.meshes.new(body['id'])
        mesh.from_pydata([[v / 1000 for v in point] for point in body['vertices']], [], body['triangles'])
        mesh.update()
        bpy.context.collection.objects.link(bpy.data.objects.new(body['id'], mesh))
    publish(str(Path(output) / name), configure_robot=lambda stage: robot['migrate_assembly'](stage, request['assembly']))
print('VALIDATION_MODELS_READY')
