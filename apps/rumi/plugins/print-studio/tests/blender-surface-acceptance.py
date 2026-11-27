"""Bake the real-USD acceptance cases, compare every vertex, and render before/after.

Run Blender --background --python-exit-code 1 --python this_file -- output_dir helper_path.
Only scratch output is written; the source .blend is reopened for each case.
"""
import json
import math
from pathlib import Path
import runpy
import sys
import subprocess

import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree
from mathutils.bvhtree import BVHTree

output, helper_path, *options = sys.argv[sys.argv.index('--') + 1:]
output = Path(output)
helper = runpy.run_path(helper_path)


def geometry(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return ([evaluated.matrix_world @ v.co * 1000 for v in mesh.vertices],
                [tuple(t.vertices) for t in mesh.loop_triangles])
    finally:
        evaluated.to_mesh_clear()


def side_thickness(points, triangles):
    tree = BVHTree.FromPolygons(points, triangles, all_triangles=True)
    widths = []
    for z in range(40, 161, 10):
        for y in range(-60, 61, 10):
            hits = []
            origin = Vector((150, y, z))
            direction = Vector((-1, 0, 0))
            for _ in range(6):
                point, _, _, _ = tree.ray_cast(origin, direction, 300)
                if point is None:
                    break
                hits.append(point.x)
                origin = point + direction * .001
            if len(hits) >= 2 and hits[1] > 0:
                widths.append(hits[0] - hits[1])
    assert widths, 'No side-wall thickness samples'
    return min(widths)


def render(name):
    if '--skip-renders' in options:
        return
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 12
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new('AcceptanceWorld')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.6, .6, .6, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .8
    target = Vector((0, 0, .105))
    camera_data = bpy.data.cameras.new('AcceptanceCamera')
    camera = bpy.data.objects.new('AcceptanceCamera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = .29
    for view, position in [('side', (.7, 0, .105)), ('front', (.4, -.7, .3))]:
        camera.location = position
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(output / f'{name}-{view}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)


reports = {}
for case in ('profile', 'facet'):
    data = json.loads((output / f'{case}.json').read_text())
    bpy.ops.wm.open_mainfile(filepath=data['blend'])
    baseline = {obj.name: geometry(obj) for obj in bpy.context.scene.objects if obj.name in data['expected']}
    if case == 'profile' and not (output / 'before-side.png').exists():
        render('before')
    matches, unchanged = {}, {}
    for name, (points, _) in baseline.items():
        expected = data['expected'][name]
        tree = KDTree(len(expected))
        for i, item in enumerate(expected):
            tree.insert(Vector(item['before']), i)
        tree.balance()
        matches[name], unchanged[name] = [], []
        for point in points:
            _, index, distance = tree.find(point)
            assert distance < .01, f'{name}: original USD differs from Blender by {distance} mm'
            matches[name].append(Vector(expected[index]['after']))
            unchanged[name].append(expected[index]['before'] == expected[index]['after'])
    recipe_path = output / f'{case}-recipe.json'
    recipe_path.write_text(json.dumps(data['recipe']))
    helper['apply_shape_controls'](recipe_path)
    max_error, min_normal_dot = 0, 1
    flipped = []
    for name, targets in matches.items():
        obj = bpy.data.objects[name]
        points, triangles = geometry(obj)
        assert len(points) == len(targets), 'Surface bake changed topology'
        max_error = max(max_error, max((p - target).length for p, target in zip(points, targets)))
        old, _ = baseline[name]
        assert all(tuple(points[i]) == tuple(old[i]) for i, fixed in enumerate(unchanged[name]) if fixed), f'{name}: zero-displacement vertices changed on save'
        for a, b, c in triangles:
            old_normal = (old[b] - old[a]).cross(old[c] - old[a])
            if old_normal.length < .0001:
                continue
            new_normal = (points[b] - points[a]).cross(points[c] - points[a])
            assert new_normal.length > .00001, f'{name}: collapsed face'
            dot = old_normal.normalized().dot(new_normal.normalized())
            min_normal_dot = min(min_normal_dot, dot)
            if dot <= 0:
                flipped.append(dict(part=name, area=old_normal.length / 2, point=list(old[a]), dot=dot))
    assert max_error < .01, f'Preview/bake mismatch: {max_error} mm'
    print('FLIPPED', flipped[:10], 'total', len(flipped), flush=True)
    assert min_normal_dot > 0, f'Flipped triangle: {min_normal_dot}'
    shell = geometry(bpy.data.objects['Shell'])
    thickness = side_thickness(*shell)
    assert thickness > 1, f'Side wall collapsed: {thickness} mm'
    render(case)
    # Re-export through the production publisher to exercise its saved-result path.
    published = helper['publish'](str(output / f'{case}-saved'), check=False)
    reports[case] = dict(maxPreviewBakeErrorMm=max_error, minTriangleNormalDot=min_normal_dot,
                         minSampledSideWallMm=thickness, published=published)
# Exercise the full declared control range through the production save path.
profile = json.loads((output / 'profile.json').read_text())
axes = [axis for control in profile['recipe']['controls'] for axis in control['axes']]
endpoints = []
for axis in axes:
    for end in ('min', 'max'):
        values = {key: 0 for key in profile['recipe']['values']}
        values[axis['key']] = axis[end]
        endpoints.append((axis['key'] + '-' + end, values))
for end in ('min', 'max'):
    endpoints.append(('combined-' + end, {axis['key']: axis[end] for axis in axes}))
for label, values in endpoints:
    bpy.ops.wm.open_mainfile(filepath=profile['blend'])
    recipe = dict(profile['recipe'], values=values)
    recipe_path = output / ('endpoint-' + label + '.json')
    recipe_path.write_text(json.dumps(recipe))
    helper['apply_shape_controls'](recipe_path)
    thickness = side_thickness(*geometry(bpy.data.objects['Shell']))
    assert thickness > 1, f'{label}: side wall below project minimum'
    published = helper['publish'](str(output / ('endpoint-' + label)), check=False)
    reports['profile-' + label] = dict(minSampledSideWallMm=thickness, published=published)

# The same production validator must not report additional geometric defects.
settings = dict(minimumThicknessMm=1, degenerateThreshold=.000001, overhangDegrees=45, sharpDegrees=160, distortionDegrees=45, minimumClearanceMm=.2)
checks = {}
for name, source in [('before', data['source'])] + [(name, reports[name]['published']['preview']) for name in reports]:
    request = dict(input=source, output=str(output / (name + '-checks.json')), stage='geometry', volume=None, settings=settings,
                   transform=dict(scale=1, rotate=dict(x=0, y=0, z=0), position=dict(x=0, y=0, z=0)))
    request_path = output / (name + '-check-request.json')
    request_path.write_text(json.dumps(request))
    with (output / (name + '-checks.log')).open('w') as log:
        subprocess.run([bpy.app.binary_path, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
                        '--python', str(Path(helper_path).with_name('validate.py')), '--', str(request_path)],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=90)
    checks[name] = {item['code']: item['count'] for item in json.loads(Path(request['output']).read_text())['checks']}
(output / 'geometry-check-comparison.json').write_text(json.dumps(checks, indent=2))
for name in reports:
    for code in ('non_manifold_edges', 'inconsistent_winding', 'intersecting_faces', 'degenerate_faces', 'degenerate_edges'):
        assert checks[name][code] <= checks['before'][code], f"{name}: {code} increased from {checks['before'][code]} to {checks[name][code]}"
(output / 'bake-report.json').write_text(json.dumps(reports, indent=2))
print('SURFACE_ACCEPTANCE ' + json.dumps(reports))
