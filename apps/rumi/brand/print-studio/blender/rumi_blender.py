"""Blender-only import and versioned export helpers. Work in metres with Z up."""
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import uuid

from pxr import Usd
import runpy
_robot = runpy.run_path(str(Path(__file__).with_name("robot_usd.py")))
initialize_robot = _robot["initialize_robot"]
description_layer = _robot["description_layer"]
restore_description = _robot["restore_description"]
read_robot = _robot["read_robot"]

import bpy


def import_mesh(path):
    """Import self-contained USD, legacy GLB (metres), or Rumi STL (millimetres)."""
    path = Path(path).resolve()
    if path.suffix.lower() in ('.usd', '.usda'):
        text = path.read_text()
        if not text.startswith('#usda 1.0') or '@' in text:
            raise ValueError('Import a self-contained ASCII USD layer')
        stage = Usd.Stage.Open(str(path))
        read_robot(stage)
        if bpy.context.scene.get('rumi_robot_description'):
            raise ValueError('Compose robot descriptions explicitly before importing another assembly')
        bpy.ops.wm.usd_import(filepath=str(path))
        bpy.context.scene['rumi_robot_description'] = description_layer(stage)
    elif path.suffix.lower() == '.glb':
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
        raise ValueError('Import USD, GLB or STL; open .blend originals with bpy.ops.wm.open_mainfile')


CHECKS_TIMEOUT_SECONDS = 60
CHECKS_NOTE = 'Bullet mechanics were not run; call validation_mechanics when the design is ready.'


def _unavailable(message):
    return dict(status='unavailable', message=str(message)[:400])


def run_checks(usd, model_directory):
    """Check a published revision in a separate Blender process and return a bounded summary.

    The validator deletes every scene object, so it never runs in the calling process. Settings
    come from the nearest ancestor `.rumi/print-checks.json`, written by `blender_status`. Every
    failure, including a timeout, yields status "unavailable"; nothing here raises or reports a pass.
    """
    project = next((parent for parent in (Path(model_directory).resolve(), *Path(model_directory).resolve().parents)
                    if (parent / '.rumi' / 'print-checks.json').is_file()), None)
    if project is None:
        return _unavailable('Call blender_status in this project, then publish again.')
    scratch = None
    try:
        settings = json.loads((project / '.rumi' / 'print-checks.json').read_text())['settings']
        (project / '.rumi' / 'tmp').mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix='check-', dir=project / '.rumi' / 'tmp'))
        output = scratch / 'result.json'
        request = scratch / 'request.json'
        request.write_text(json.dumps(dict(
            input=str(usd), output=str(output), mechanicsOutput=str(scratch / 'mechanics.json'),
            stage='all', volume=None, settings=settings,
            transform=dict(scale=1, rotate=dict(x=0, y=0, z=0), position=dict(x=0, y=0, z=0)))))
        environment = {key: value for key, value in os.environ.items() if not key.startswith('PYTHON')}
        environment['PYTHONDONTWRITEBYTECODE'] = '1'
        completed = subprocess.run(
            [bpy.app.binary_path, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
             '--python', str(Path(__file__).with_name('validate.py')), '--', str(request)],
            capture_output=True, text=True, timeout=CHECKS_TIMEOUT_SECONDS, env=environment, cwd=scratch)
        if completed.returncode != 0:
            return _unavailable('Check process failed: ' + (completed.stdout + completed.stderr)[-300:])
        result = json.loads(output.read_text())
        summary = dict(
            status='needs_repair' if result.get('robotError') else result['status'],
            checks=[{key: item[key] for key in ('code', 'count', 'severity', 'details') if key in item}
                    for item in result['checks'] if item['count']],
            dimensionsMm={axis: round(result['dimensions'][axis], 2) for axis in 'xyz'},
            note=CHECKS_NOTE)
        if result.get('robotError'):
            summary['assemblyError'] = str(result['robotError'])[:400]
        return summary
    except subprocess.TimeoutExpired:
        return _unavailable('Checks exceeded %d seconds.' % CHECKS_TIMEOUT_SECONDS)
    except Exception as error:
        return _unavailable('%s: %s' % (type(error).__name__, error))
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)


def publish(model_directory, configure_robot=None, check=True):
    """Atomically publish self-contained model.usda and a recoverable editable .blend.

    With check=True, the published revision is then checked in a separate Blender process and
    `RUMI_CHECKS <json>` is printed and returned as report['checks'].

    configure_robot(stage), when supplied, authors USD Physics joints and Isaac
    relationships on the exported stage. Otherwise saved USD declarations persist.
    Meshes are rigid links; unsupported articulation remains a validation finding.
    """
    directory = Path(model_directory).resolve()
    meshes = [obj for obj in bpy.context.scene.objects
              if obj.type == 'MESH' and obj.visible_get() and not obj.hide_render]
    if not meshes:
        raise ValueError('No visible mesh objects to publish')
    graph = bpy.context.evaluated_depsgraph_get()
    triangles, points = 0, []
    for obj in meshes:
        evaluated = obj.evaluated_get(graph)
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
        raise ValueError('Preview requires 1–200,000 triangles; preserve detailed originals')
    revision = directory / 'revisions' / uuid.uuid4().hex
    revision.mkdir(parents=True, exist_ok=False)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    usd = revision / 'model.usda'
    bpy.ops.wm.usd_export(
        filepath=str(usd), selected_objects_only=True, export_animation=False,
        export_materials=True, export_textures=False, export_armatures=False,
        export_shapekeys=False, export_hair=False, export_lights=False,
        export_cameras=False, export_curves=False, export_points=False,
        export_volumes=False, root_prim_path='/Model', merge_parent_xform=True,
        author_blender_name=False, export_custom_properties=False,
        triangulate_meshes=True, use_instancing=False,
    )
    stage = Usd.Stage.Open(str(usd))
    initialize_robot(stage)
    saved = bpy.context.scene.get('rumi_robot_description')
    if saved:
        restore_description(stage, saved)
    elif bpy.context.scene.get('rumi_assembly_json'):
        _robot['migrate_assembly'](stage, json.loads(bpy.context.scene['rumi_assembly_json']))
    elif configure_robot is None and any(bpy.context.scene.get(key) for key in ['rumi_mechanisms_json', 'rumiMotionKeys']):
        raise ValueError('Legacy movement needs explicit USD Physics joints before publishing')
    if configure_robot is not None:
        configure_robot(stage)
    metadata = read_robot(stage)
    stage.GetRootLayer().Save()
    if not 10 <= usd.stat().st_size <= 64 * 1024 * 1024 or '@' in usd.read_text():
        raise ValueError('USD must fit 64 MiB and contain no external assets; use embedded surface colours')
    bpy.context.scene['rumi_robot_description'] = description_layer(stage)
    for key in ['rumi_assembly_json', 'rumi_mechanisms_json', 'rumiMotionKeys', 'rumiMotionRanges']:
        if key in bpy.context.scene:
            del bpy.context.scene[key]
    bpy.ops.wm.save_as_mainfile(filepath=str(revision / 'model.blend'))
    report = {
        'blend': str(revision / 'model.blend'), 'revisionUsd': str(usd),
        'preview': str(directory / 'model.usda'), 'triangles': triangles,
        'parts': [part['mesh'] for part in metadata['assembly']['parts']],
        'dimensionsMm': {axis: (max(p[i] for p in points)-min(p[i] for p in points))*1000
                         for i, axis in enumerate('xyz')},
        'printReady': False,
    }
    (revision / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    temporary = directory / ('.preview-' + uuid.uuid4().hex + '.usda')
    try:
        shutil.copyfile(usd, temporary)
        os.replace(temporary, directory / 'model.usda')
    finally:
        temporary.unlink(missing_ok=True)
    print('RUMI_MODEL ' + json.dumps(report))
    if check:
        report['checks'] = run_checks(usd, directory)
        print('RUMI_CHECKS ' + json.dumps(report['checks'], separators=(',', ':')))
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
