"""Read an immutable mesh snapshot and emit structured Print Toolbox findings."""
import json
import math
import random
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import object_print3d_utils as toolbox


def validate(request):
    """Validate evaluated geometry in millimetres without changing project files."""
    toolbox.register()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    path = request['input']
    if path.endswith('.glb'):
        bpy.ops.import_scene.gltf(filepath=path)
        factor = 1000
    else:
        bpy.ops.wm.stl_import(filepath=path)
        factor = 1
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and not obj.hide_render]
    if not meshes:
        raise ValueError('No mesh geometry to validate')
    mechanics_meshes = []
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
    dimensions = {axis: high[i]-low[i] for i, axis in enumerate('xyz')}
    volume = request['volume']
    if volume is not None:
        checks.append(dict(code='oversized', count=int(any(dimensions[a] > volume[a] for a in 'xyz')), severity='error'))
    return dict(version=1, status='needs_repair' if any(c['count'] and c['severity'] == 'error' for c in checks)
                else 'review' if any(c['count'] for c in checks) else 'passed', checks=checks,
                dimensions=dimensions, settings=settings, printReady=False)


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
    result = validate(request)
    Path(request['output']).write_text(json.dumps(result, allow_nan=False)+'\n')
