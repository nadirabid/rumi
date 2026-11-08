"""Blender-only import and versioned export helpers. Work in metres with Z up."""
import json
import math
import os
from pathlib import Path
import shutil
import struct
import uuid

import bpy


def import_mesh(path):
    """Import standard GLB (metres) or Rumi STL (millimetres) into Blender."""
    path = Path(path).resolve()
    if path.suffix.lower() == '.glb':
        data = path.read_bytes()
        length = struct.unpack_from('<I', data, 12)[0]
        manifest = json.loads(data[20:20+length])
        extras = manifest.get('asset', {}).get('extras', {})
        assembly = extras.get('rumiAssembly')
        if assembly is not None:
            if not isinstance(assembly, dict) or assembly.get('version') != 1 or not isinstance(assembly.get('parts'), list):
                raise ValueError('Imported assembly must be a version 1 description with named parts')
            if bpy.context.scene.get('rumi_assembly_json'):
                raise ValueError('Compose assemblies explicitly; importing cannot replace an existing assembly description')
            if any(not isinstance(part, dict) or not isinstance(part.get('mesh'), str)
                   or part['mesh'] in bpy.context.scene.objects for part in assembly['parts']):
                raise ValueError('Imported assembly mesh names must be valid and distinct from existing objects')
        declarations = extras.get('rumiMechanisms')
        if declarations is not None:
            if not isinstance(declarations, list):
                raise ValueError('Imported mechanisms must be a list')
            if declarations and json.loads(bpy.context.scene.get('rumi_mechanisms_json', '[]')):
                raise ValueError('Compose mechanisms explicitly with unique part names and publish their combined declarations; importing cannot replace existing movements')
            if any(isinstance(item, dict) and item.get('movingBody') in bpy.context.scene.objects for item in declarations):
                raise ValueError('Imported moving parts collide with existing object names; rename and compose declarations explicitly')
        bpy.ops.import_scene.gltf(filepath=str(path))
        if declarations:
            bpy.context.scene['rumi_mechanisms_json'] = json.dumps(declarations, allow_nan=False)
        if assembly is not None:
            bpy.context.scene['rumi_assembly_json'] = json.dumps(assembly, allow_nan=False)
        for key in ('rumiMotionKeys', 'rumiMotionRanges'):
            if key in extras:
                bpy.context.scene[key] = json.dumps(extras[key], allow_nan=False)
    elif path.suffix.lower() == '.stl':
        bpy.ops.wm.stl_import(filepath=str(path), global_scale=0.001)
    else:
        raise ValueError('Import a GLB or STL; open .blend originals with bpy.ops.wm.open_mainfile')


def publish(model_directory, mechanisms=None, assembly=None):
    """Save a new editable revision and atomically replace model.glb after validation.

    The scene uses metres, Z up. Evaluated visible mesh objects must fit the
    200,000-triangle preview limit. Originals retain modifiers in the .blend.
    Assembly version 1 maps physical part ids to mesh object names. Axes and
    pivots use millimetres/Z up; rotation ranges use degrees relative to the
    saved pose. None retains the scene description. Legacy mechanisms remain
    readable but require an assembly upgrade before mechanical acceptance.
    Failed exports never replace the previous preview; partial revisions may
    remain for diagnosis. This checks geometry validity, not print readiness.
    """
    directory = Path(model_directory).resolve()
    if mechanisms is not None:
        if not isinstance(mechanisms, list):
            raise ValueError('Mechanisms must be a list of saved movement declarations')
        bpy.context.scene['rumi_mechanisms_json'] = json.dumps(mechanisms, allow_nan=False)
    if assembly is not None:
        if not isinstance(assembly, dict) or assembly.get('version') != 1:
            raise ValueError('Assembly must be a version 1 description')
        bpy.context.scene['rumi_assembly_json'] = json.dumps(assembly, allow_nan=False)
    saved_assembly = bpy.context.scene.get('rumi_assembly_json')
    if saved_assembly is not None:
        assembly = json.loads(saved_assembly)
    saved_mechanisms = bpy.context.scene.get('rumi_mechanisms_json')
    if saved_mechanisms is not None:
        mechanisms = json.loads(saved_mechanisms)
    meshes = [obj for obj in bpy.context.scene.objects
              if obj.type == 'MESH' and obj.visible_get() and not obj.hide_render]
    if not meshes:
        raise ValueError('No visible mesh objects to publish')
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    points = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            for vertex in mesh.vertices:
                point = evaluated.matrix_world @ vertex.co
                if not all(math.isfinite(v) for v in point):
                    raise ValueError('Nonfinite coordinates in ' + obj.name)
                points.append(tuple(point))
        finally:
            evaluated.to_mesh_clear()
    if not 0 < triangles <= 200000:
        raise ValueError('Preview requires 1–200,000 triangles; preserve the detailed original and explicitly make a lighter preview')
    revision = directory / 'revisions' / uuid.uuid4().hex
    revision.mkdir(parents=True, exist_ok=False)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.ops.wm.save_as_mainfile(filepath=str(revision / 'model.blend'))
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    glb = revision / 'model.glb'
    bpy.ops.export_scene.gltf(
        filepath=str(glb), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_animations=False,
        export_skins=False, export_morph=False, export_cameras=False,
        export_lights=False, export_extras=True,
    )
    if not glb.is_file() or not 20 <= glb.stat().st_size <= 64 * 1024 * 1024:
        raise ValueError('GLB export failed or exceeded 64 MiB; previous preview retained')
    metadata = {}
    if mechanisms is not None:
        metadata['rumiMechanisms'] = mechanisms
    if assembly is not None:
        metadata['rumiAssembly'] = assembly
    for key in ('rumiMotionKeys', 'rumiMotionRanges'):
        if key in bpy.context.scene:
            metadata[key] = json.loads(bpy.context.scene[key])
    if metadata:
        data = glb.read_bytes()
        length = struct.unpack_from('<I', data, 12)[0]
        manifest = json.loads(data[20:20+length])
        manifest['asset'].setdefault('extras', {}).update(metadata)
        encoded = json.dumps(manifest, allow_nan=False).encode('utf8')
        encoded += b' ' * (-len(encoded) % 4)
        tail = data[20+length:]
        if 20 + len(encoded) + len(tail) > 64 * 1024 * 1024:
            raise ValueError('GLB movement metadata exceeded 64 MiB; previous preview retained')
        glb.write_bytes(struct.pack('<IIIII', 0x46546c67, 2, 20+len(encoded)+len(tail), len(encoded), 0x4e4f534a) + encoded + tail)
    report = {
        'blend': str(revision / 'model.blend'), 'revisionGlb': str(glb),
        'preview': str(directory / 'model.glb'), 'triangles': triangles,
        'parts': [obj.name for obj in meshes],
        'dimensionsMm': {axis: (max(p[i] for p in points) - min(p[i] for p in points)) * 1000
                         for i, axis in enumerate('xyz')},
        'printReady': False,
    }
    (revision / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    temporary = directory / ('.preview-' + uuid.uuid4().hex + '.glb')
    try:
        shutil.copyfile(glb, temporary)
        os.replace(temporary, directory / 'model.glb')
    finally:
        temporary.unlink(missing_ok=True)
    print('RUMI_MODEL ' + json.dumps(report))
    return report


def shape_point(point, recipe):
    """Evaluate the analog v1 deformation in model-local millimetres."""
    from mathutils import Vector
    n = Vector(recipe['direction']).normalized()
    up = Vector((0, 0, 1) if abs(n.z) < .9 else (0, 1, 0))
    u = up.cross(n).normalized()
    v = n.cross(u)
    a = recipe['values']
    radii = recipe['radii']
    center = Vector(recipe['center']) + u * ((a['peakX'] - .5) * radii[0]) + v * ((a['peakY'] - .5) * radii[1])
    point = Vector(point)
    d = point - center
    q = [d.dot(u), d.dot(v), d.dot(n)]
    spread = .5 + a['spread']
    r2 = sum((q[i] / (radii[i] * spread)) ** 2 for i in range(3))
    weight = max(0, 1 - r2) ** (1.5 + 4 * a['falloff'])
    strength = a['amount'] * 2 - 1
    out = list(q)
    operation = recipe['operation']
    if operation == 'bulge':
        tilt = (a['angle'] - .5) * math.pi * 2 / 3
        out[1] += math.sin(tilt) * strength * recipe['limit'] * weight
        out[2] += math.cos(tilt) * strength * recipe['limit'] * weight
    elif operation == 'taper':
        scale = 1 + strength * .6 * weight
        out[0] *= scale
        out[1] *= scale
    else:
        angle = strength * math.pi / 2 * weight * (q[1] / radii[1] if operation == 'bend' else q[2] / radii[2])
        c, s = math.cos(angle), math.sin(angle)
        if operation == 'twist':
            out[0], out[1] = c*q[0]-s*q[1], s*q[0]+c*q[1]
        else:
            out[1], out[2] = c*q[1]-s*q[2], s*q[1]+c*q[2]
    return point + u*(out[0]-q[0]) + v*(out[1]-q[1]) + n*(out[2]-q[2])


def cut_plane(recipe):
    """Return the retained half-space in model millimetres, matching cutPlane."""
    from mathutils import Vector
    n = Vector(recipe['direction']).normalized()
    up = Vector((0, 0, 1) if abs(n.z) < .9 else (0, 1, 0))
    u, a = up.cross(n).normalized(), recipe['values']
    v = n.cross(u)
    normal = (n - v * math.tan((a['angle'] - .5) * math.pi * 2 / 3)
              - u * math.tan((a['spread'] - .5) * math.pi * 2 / 3)).normalized()
    point = Vector(recipe['center']) + n * ((a['amount'] * 2 - 1) * recipe['limit'])
    return normal, point


def cut_mesh(mesh, matrix, recipe):
    """Intersect an evaluated mesh with a bounded half-space, retaining material slots and cavity openings."""
    import bmesh
    from mathutils import Vector
    normal, point = cut_plane(recipe)
    point /= 1000
    extent = max(((matrix @ vertex.co) - point).length for vertex in mesh.vertices) * 2 + .001
    cutter_mesh = bpy.data.meshes.new('RumiCutVolume')
    cutter = bpy.data.objects.new('RumiCutVolume', cutter_mesh)
    temporary = bpy.data.objects.new('RumiCutPreview', mesh)
    try:
        bm = bmesh.new()
        try:
            bmesh.ops.create_cube(bm, size=extent * 2)
            bm.to_mesh(cutter_mesh)
        finally:
            bm.free()
        bpy.context.scene.collection.objects.link(cutter)
        bpy.context.scene.collection.objects.link(temporary)
        cutter.rotation_mode = 'QUATERNION'
        cutter.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(normal)
        cutter.location = point + normal * extent
        temporary.matrix_world = matrix
        modifier = temporary.modifiers.new('Rumi continuous cut', 'BOOLEAN')
        modifier.operation = 'INTERSECT'
        modifier.solver = 'EXACT'
        modifier.object = cutter
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        return bpy.data.meshes.new_from_object(temporary.evaluated_get(graph), depsgraph=graph)
    finally:
        bpy.data.objects.remove(temporary, do_unlink=True)
        bpy.data.objects.remove(cutter, do_unlink=True)
        bpy.data.meshes.remove(cutter_mesh)


def apply_shape_controls(recipe_path):
    """Bake a frozen viewer recipe into evaluated meshes in the current Blender scene.

    Open the original .blend first and publish a new revision afterward. The
    original file is untouched. Evaluated modifiers are baked on affected parts;
    their editable stack remains in the original revision. A changed source GLB
    rejects the recipe before any mesh changes.
    """
    import hashlib
    recipe = json.loads(Path(recipe_path).read_text())
    if recipe.get('version') != 1 or not recipe.get('frozen') or recipe.get('operation') not in ['bulge', 'bend', 'twist', 'taper', 'cut']:
        raise ValueError('Use a frozen v1 recipe from viewer_controls')
    values = recipe.get('values', {})
    for key in ['amount', 'spread', 'peakX', 'peakY', 'falloff', 'angle']:
        if not isinstance(values.get(key), (int, float)) or not math.isfinite(values[key]) or not 0 <= values[key] <= 1:
            raise ValueError('Invalid control value: ' + key)
    for key in ['center', 'radii', 'direction']:
        vector = recipe.get(key)
        if not isinstance(vector, list) or len(vector) != 3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in vector):
            raise ValueError('Invalid frame: ' + key)
    if min(recipe['radii']) <= 0 or sum(n*n for n in recipe['direction']) < .000001 or not 0 < recipe['limit'] <= min(recipe['radii']):
        raise ValueError('Invalid deformation extent')
    if hashlib.sha256(Path(recipe['source']).read_bytes()).hexdigest() != recipe['sourceHash']:
        raise ValueError('Source model changed; reopen shape controls')
    parts = recipe.get('parts')
    if not isinstance(parts, list) or any(not isinstance(name, str) or not name for name in parts):
        raise ValueError('Recipe parts must be a list of exact mesh names')
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.visible_get() and not obj.hide_render and (not parts or obj.name in parts)]
    if not objects:
        raise ValueError('No visible mesh matches the recipe parts')
    graph = bpy.context.evaluated_depsgraph_get()
    pending = []
    try:
        for obj in objects:
            evaluated = obj.evaluated_get(graph)
            matrix = evaluated.matrix_world.copy()
            inverse = matrix.inverted()
            mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=graph)
            pending.append((obj, mesh, matrix))
            if recipe['operation'] == 'cut':
                if mesh.vertices:
                    trimmed = cut_mesh(mesh, matrix, recipe)
                    pending[-1] = (obj, trimmed, matrix)
                    bpy.data.meshes.remove(mesh)
            else:
                for vertex in mesh.vertices:
                    vertex.co = inverse @ (shape_point((matrix @ vertex.co) * 1000, recipe) / 1000)
        untouched = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.visible_get() and not obj.hide_render and obj not in objects]
        if not any(mesh.polygons for _, mesh, _ in pending) and not any(obj.data.polygons for obj in untouched):
            raise ValueError('The cut removes the entire model; reopen controls and lower the cut')
        for obj, mesh, matrix in pending:
            obj.modifiers.clear()
            obj.constraints.clear()
            obj.animation_data_clear()
            obj.parent = None
            obj.data = mesh
            obj.matrix_world = matrix
            if not mesh.polygons:
                obj.hide_render = True
                obj.hide_set(True)
            mesh.update()
    except Exception:
        for obj, mesh, matrix in pending:
            if obj.data != mesh:
                bpy.data.meshes.remove(mesh)
        raise
    return {'operation': recipe['operation'], 'parts': [obj.name for obj in objects], 'values': values}
