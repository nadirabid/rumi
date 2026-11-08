"""Create private integration fixtures and verify physical frames survive Blender export."""
import importlib.util
import json
from pathlib import Path
import runpy
import struct
import sys

import bpy
from mathutils import Euler, Vector

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixtures', root / 'bullet/tests/fixtures.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
publish = runpy.run_path(str(root / 'blender/rumi_blender.py'))
validation = runpy.run_path(str(root / 'blender/validate.py'))
output = Path(sys.argv[sys.argv.index('--') + 1])
settings = dict(minimumThicknessMm=1, degenerateThreshold=.000001, overhangDegrees=45,
                sharpDegrees=160, distortionDegrees=45)


def metadata(path):
    data = Path(path).read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+length])['asset']['extras']['rumiAssembly']


for variant in ('normal', 'broken', 'blocked', 'point-touching', 'wheel', 'static'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    request = fixtures.wheel() if variant == 'wheel' else fixtures.request(variant == 'broken')
    if variant == 'static':
        request = fixtures.assembly([fixtures.box('block', [0, 0, 0], [10, 10, 10])], 'block', [])
    if variant == 'blocked':
        request['bodies'].append(fixtures.box('obstacle', [0,-13,10], [20,2,3]))
    if variant == 'point-touching':
        moving = request['bodies'][1]
        point = max(moving['vertices'], key=sum)
        offset = len(moving['vertices'])
        moving['vertices'].extend([point, [point[0]+.1,point[1],point[2]],
            [point[0]+.1,point[1]+.1,point[2]], [point[0]+.1,point[1],point[2]+.1]])
        moving['triangles'].extend([[index+offset for index in face] for face in [[0,2,1],[0,1,3],[0,3,2],[1,2,3]]])
    for body in request['bodies']:
        mesh = bpy.data.meshes.new(body['id'])
        mesh.from_pydata([[value / 1000 for value in point] for point in body['vertices']], [], body['triangles'])
        mesh.update()
        obj = bpy.data.objects.new(body['id'], mesh)
        bpy.context.collection.objects.link(obj)
    if variant == 'blocked':
        request['assembly']['parts'].append(dict(id='obstacle', mesh='obstacle'))
        request['assembly']['connections'].append(dict(id='mount_obstacle', parent=request['assembly']['root'], child='obstacle', kind='fixed'))
    description = request['assembly']
    report = publish['publish'](str(output / variant), assembly=description)
    assert metadata(report['preview']) == description
    if variant == 'static':
        bpy.ops.wm.stl_export(filepath=str(output / variant / 'model.stl'), global_scale=1000)
    if variant == 'normal':
        bpy.ops.wm.open_mainfile(filepath=report['blend'])
        retained = publish['publish'](str(output / 'reopened'))
        assert metadata(retained['preview']) == description
        bpy.ops.wm.read_factory_settings(use_empty=True)
        publish['import_mesh'](report['preview'])
        retained = publish['publish'](str(output / 'imported'))
        assert metadata(retained['preview']) == description
        before = len(bpy.context.scene.objects)
        try:
            publish['import_mesh'](report['preview'])
            raise AssertionError('A second import silently replaced existing movement declarations')
        except ValueError as error:
            assert 'Compose assemblies explicitly' in str(error)
        assert len(bpy.context.scene.objects) == before
        assert json.loads(bpy.context.scene['rumi_assembly_json']) == description
        transform = dict(scale=1.3, rotate=dict(x=20,y=30,z=40), position=dict(x=14,y=-23,z=6))
        geometry_path = output / 'placed.json'
        try:
            validation['validate'](dict(input=report['preview'], settings=settings, transform=transform,
                volume=None, mechanicsOutput=str(geometry_path), assembly=description))
        finally:
            validation['toolbox'].unregister()
        geometry = json.loads(geometry_path.read_text())
        assert [body['id'] for body in geometry['bodies']] == ['fixed', 'moving']
        rotation = Euler(tuple(__import__('math').radians(transform['rotate'][axis]) for axis in 'xyz'), 'XYZ').to_matrix()
        axis = rotation @ Vector(description['connections'][0]['axis'])
        assert (axis - Vector(geometry['assembly']['connections'][0]['axis'])).length < .00001
        for original in request['bodies']:
            actual = next(body for body in geometry['bodies'] if body['id'] == original['id'])
            # Relative vectors are independent of the viewer's bottom-centre placement.
            expected = rotation @ ((Vector(original['vertices'][1]) - Vector(original['vertices'][0])) * transform['scale'])
            observed = Vector(actual['vertices'][1]) - Vector(actual['vertices'][0])
            assert (expected - observed).length < .002, (expected, observed)
        assert geometry['assembly']['root'] == description['root']
        pivot = Vector(geometry['assembly']['connections'][0]['pivot'])
        original_relative = Vector(request['bodies'][0]['vertices'][0]) - Vector(description['connections'][0]['pivot'])
        actual_relative = Vector(geometry['bodies'][0]['vertices'][0]) - pivot
        assert (rotation @ (original_relative * transform['scale']) - actual_relative).length < .002

bpy.ops.wm.read_factory_settings(use_empty=True)
for name, location in [('housing_mesh', (0, 0, 0)), ('slider_mesh', (.02, 0, 0))]:
    bpy.ops.mesh.primitive_cube_add(size=.01, location=location)
    bpy.context.object.name = name
slider = dict(version=1, root='housing', parts=[dict(id='housing', mesh='housing_mesh'), dict(id='slider', mesh='slider_mesh')],
    connections=[dict(id='slide', parent='housing', child='slider', kind='prismatic', axis=[1, 0, 0], pivot=[20, 0, 0], range=[0, 10])],
    sequences=[dict(id='extend', waypoints=[dict(slide=5), dict(slide=10)])], manufacturing=dict(mode='separate', steps=[dict(part='slider', path=[[0, 0, 0], [100, 0, 0]])]))
report = publish['publish'](str(output / 'slider-export'), assembly=slider)
geometry_path = output / 'slider-placed.json'
try:
    validation['validate'](dict(input=report['preview'], settings=settings,
        transform=dict(scale=2, rotate=dict(x=0,y=0,z=90), position=dict(x=0,y=0,z=0)),
        volume=None, mechanicsOutput=str(geometry_path), assembly=slider))
finally:
    validation['toolbox'].unregister()
geometry = json.loads(geometry_path.read_text())
assert {body['id'] for body in geometry['bodies']} == {'housing', 'slider'}
assert geometry['assembly']['connections'][0]['range'] == [0, 20]
assert geometry['assembly']['sequences'][0]['waypoints'] == [dict(slide=10), dict(slide=20)]
path = geometry['assembly']['manufacturing']['steps'][0]['path']
assert path[0] == [0, 0, 0]
assert (Vector(path[1]) - Vector((0, 200, 0))).length < .0001
assert (Vector(geometry['assembly']['connections'][0]['axis']) - Vector((0, 1, 0))).length < .00001

(output / 'settings.json').write_text(json.dumps(dict(validation=settings, mechanics=fixtures.SETTINGS)))
print('BLENDER_MECHANICS_FIXTURES_OK')
