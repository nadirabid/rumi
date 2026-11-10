"""Read an immutable mesh snapshot and emit structured Print Toolbox findings."""
import json
import copy
import math
import random
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import object_print3d_utils as toolbox


def measure_clearances(bodies, assembly, threshold):
    """Return part pairs closer than `threshold` millimetres as (gap, a, b), nearest first.

    Bodies carry placed millimetre vertices and triangles. Pairs joined directly by a fixed
    connection are skipped. Overlapping solids have gap 0; otherwise the gap is the smaller of
    the two vertex-to-surface distances, so it is a screening measure that can miss a pure
    edge-to-edge minimum. Pairs whose bounding boxes are farther apart than `threshold` are
    rejected without a surface query.
    """
    fixed = {frozenset((item['parent'], item['child'])) for item in assembly['connections']
             if item['kind'] == 'fixed'}
    boxes = [(Vector(tuple(min(p[i] for p in body['vertices']) for i in range(3))),
              Vector(tuple(max(p[i] for p in body['vertices']) for i in range(3)))) for body in bodies]
    trees = {}

    def tree(index):
        if index not in trees:
            trees[index] = BVHTree.FromPolygons(bodies[index]['vertices'], bodies[index]['triangles'])
        return trees[index]

    def reach(source, target):
        low, high = boxes[target]
        best = None
        for point in bodies[source]['vertices']:
            if any(point[i] < low[i] - threshold or point[i] > high[i] + threshold for i in range(3)):
                continue
            location, _, _, distance = tree(target).find_nearest(Vector(point), threshold)
            if location is not None and (best is None or distance < best):
                best = distance
        return best

    pairs = []
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            if frozenset((bodies[i]['id'], bodies[j]['id'])) in fixed:
                continue
            separation = Vector(tuple(max(0, boxes[i][0][k] - boxes[j][1][k], boxes[j][0][k] - boxes[i][1][k])
                                      for k in range(3))).length
            if separation >= threshold:
                continue
            if tree(i).overlap(tree(j)):
                gap = 0.0
            else:
                found = [d for d in (reach(i, j), reach(j, i)) if d is not None]
                if not found or min(found) >= threshold:
                    continue
                gap = min(found)
            pairs.append((gap, bodies[i]['id'], bodies[j]['id']))
    return sorted(pairs)


def validate(request):
    """Validate evaluated geometry in millimetres without changing project files."""
    stage = request.get('stage', 'all')
    if stage not in ('all', 'assembly', 'geometry', 'fit'):
        raise ValueError('Unknown validation stage')
    toolbox.register()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    path = request['input']
    robot = None
    robot_error = None
    if path.endswith(('.usda', '.usd')):
        from pxr import Usd
        from robot_usd import read_robot
        try:
            robot = read_robot(Usd.Stage.Open(path))
            request['assembly'] = copy.deepcopy(robot['assembly'])
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            robot_error = str(error)
            request.pop('mechanicsOutput', None)
        if stage == 'assembly':
            return dict(version=1, status='needs_repair' if robot_error else 'passed', checks=[],
                        dimensions=dict(x=0, y=0, z=0), printReady=False, robot=robot, robotError=robot_error)
        bpy.ops.wm.usd_import(filepath=path)
        factor = 1000
    elif path.endswith('.glb'):
        bpy.ops.import_scene.gltf(filepath=path)
        factor = 1000
    else:
        bpy.ops.wm.stl_import(filepath=path)
        factor = 1
    if stage == 'assembly':
        return dict(version=1, status='passed', checks=[], dimensions=dict(x=0, y=0, z=0), printReady=False)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and not obj.hide_render]
    if not meshes:
        raise ValueError('No mesh geometry to validate')
    mechanics_meshes = []
    clearance = None
    if 'mechanicsOutput' in request:
        if len(meshes) > 128:
            raise ValueError('Mechanical validation supports at most 128 mesh bodies')
        assembly = request['assembly']
        names = {part['mesh']: part['id'] for part in assembly['parts']}
        if len(names) != len(assembly['parts']) or set(names) != {part.name for part in meshes}:
            raise ValueError('Assembly part mappings must match every imported mesh exactly')
        graph = bpy.context.evaluated_depsgraph_get()
        total_triangles = 0
        for part in meshes:
            evaluated = part.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            bm = bmesh.new()
            try:
                mesh.calc_loop_triangles()
                total_triangles += len(mesh.loop_triangles)
                if total_triangles > 200000:
                    raise ValueError('Mechanical validation supports at most 200,000 triangles')
                bm.from_mesh(mesh)
                bm.transform(evaluated.matrix_world)
                if evaluated.matrix_world.determinant() < 0:
                    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
                for vertex in bm.verts:
                    vertex.co *= factor
                bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.001)
                bmesh.ops.triangulate(bm, faces=list(bm.faces))
                bm.verts.ensure_lookup_table()
                bm.verts.index_update()
                mechanics_meshes.append(dict(id=names[part.name],
                    vertices=[list(vertex.co) for vertex in bm.verts],
                    triangles=[[vertex.index for vertex in face.verts] for face in bm.faces]))
            finally:
                bm.free()
                evaluated.to_mesh_clear()
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.join()
    obj = bpy.context.object
    # Bake the full hierarchy, including shear, without decomposing it into local TRS.
    matrix = obj.matrix_world.copy()
    obj.data.transform(matrix)
    if matrix.determinant() < 0:
        obj.data.flip_normals()
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    for vertex in obj.data.vertices:
        vertex.co *= factor
    transform = request['transform']
    points = [v.co.copy() for v in obj.data.vertices]
    lower = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    upper = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    centre = (lower + upper) / 2
    rotation = Euler(tuple(math.radians(transform['rotate'][axis]) for axis in 'xyz'), 'XYZ').to_matrix()
    for vertex in obj.data.vertices:
        vertex.co = rotation @ ((vertex.co - centre) * transform['scale'])
    points = [v.co for v in obj.data.vertices]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    offset = Vector(tuple(transform['position'][axis] for axis in 'xyz')) - Vector(((low.x+high.x)/2, (low.y+high.y)/2, low.z))
    for vertex in obj.data.vertices:
        vertex.co += offset
    if 'mechanicsOutput' in request:
        def placed(point):
            return list(rotation @ ((Vector(point) - centre) * transform['scale']) + offset)
        for body in mechanics_meshes:
            body['vertices'] = [placed(vertex) for vertex in body['vertices']]
        threshold = request['settings'].get('minimumClearanceMm', 0)
        if threshold > 0 and len(mechanics_meshes) >= 2:
            clearance = (threshold, measure_clearances(mechanics_meshes, request['assembly'], threshold))
        assembly = json.loads(json.dumps(request['assembly']))
        for connection in assembly['connections']:
            if connection['kind'] == 'fixed':
                continue
            connection['pivot'] = placed(connection['pivot'])
            connection['axis'] = list(rotation @ Vector(connection['axis']))
            if connection['kind'] == 'prismatic':
                connection['range'] = [value * transform['scale'] for value in connection['range']]
        sliders = {item['id'] for item in assembly['connections'] if item['kind'] == 'prismatic'}
        for sequence in assembly.get('sequences', []):
            for waypoint in sequence['waypoints']:
                for connection_id in waypoint:
                    if connection_id in sliders:
                        waypoint[connection_id] *= transform['scale']
        for step in assembly['manufacturing'].get('steps', []):
            step['path'] = [list(rotation @ (Vector(point) * transform['scale'])) for point in step['path']]
        Path(request['mechanicsOutput']).write_text(json.dumps(dict(bodies=mechanics_meshes, assembly=assembly), allow_nan=False)+'\n')
    checks = []
    if stage in ('all', 'geometry'):
        # GLB splits vertices at material/normal seams; topology uses positional welding.
        bm = bmesh.new()
        try:
            bm.from_mesh(obj.data)
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.001)
            bm.to_mesh(obj.data)
        finally:
            bm.free()
        obj.data.update()
        settings = request['settings']
        props = bpy.context.scene.print_3d
        props.thickness_min = settings['minimumThicknessMm']
        props.threshold_zero = settings['degenerateThreshold']
        props.angle_overhang = math.radians(settings['overhangDegrees'])
        props.angle_sharp = math.radians(settings['sharpDegrees'])
        props.angle_distort = math.radians(settings['distortionDegrees'])
        random.seed(0)
        bpy.ops.mesh.print3d_check_all()
        codes = ['non_manifold_edges', 'inconsistent_winding', 'intersecting_faces',
                 'degenerate_faces', 'degenerate_edges', 'distorted_faces', 'thin_faces', 'sharp_edges', 'overhangs']
        findings = toolbox.report.info()
        if len(findings) != len(codes):
            raise ValueError('Unexpected Toolbox report version')
        checks = [dict(code=code, count=len(item[1][1]), severity='warning' if code in
                       ['thin_faces', 'sharp_edges', 'overhangs', 'distorted_faces'] else 'error')
                  for code, item in zip(codes, findings)]
    if clearance is not None:
        threshold, close = clearance
        # Either manufacturing mode needs the gap: print-in-place parts fuse, separate parts do not fit.
        checks.append(dict(code='insufficient_clearance', count=len(close), severity='error',
            details=dict(minimumClearanceMm=threshold,
                         pairs=[dict(a=a, b=b, gapMm=round(gap, 4)) for gap, a, b in close[:8]])))
    dimensions = {axis: high[i]-low[i] for i, axis in enumerate('xyz')}
    volume = request['volume']
    if volume is not None:
        checks.append(dict(code='oversized', count=int(any(dimensions[a] > volume[a] for a in 'xyz')), severity='error'))
    return dict(version=1, status='needs_repair' if any(c['count'] and c['severity'] == 'error' for c in checks)
                else 'review' if any(c['count'] for c in checks) else 'passed', checks=checks,
                dimensions=dimensions, settings=request['settings'], printReady=False, robot=robot, robotError=robot_error)


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
    result = validate(request)
    Path(request['output']).write_text(json.dumps(result, allow_nan=False)+'\n')
