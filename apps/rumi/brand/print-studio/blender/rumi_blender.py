"""Blender-only import and versioned export helpers. Work in metres with Z up."""
import json
import math
import os
from pathlib import Path
import shutil
import uuid

import bpy


def import_mesh(path):
    """Import standard GLB (metres) or Rumi STL (millimetres) into Blender."""
    path = Path(path).resolve()
    if path.suffix.lower() == '.glb':
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif path.suffix.lower() == '.stl':
        bpy.ops.wm.stl_import(filepath=str(path), global_scale=0.001)
    else:
        raise ValueError('Import a GLB or STL; open .blend originals with bpy.ops.wm.open_mainfile')


def publish(model_directory):
    """Save a new editable revision and atomically replace model.glb after validation.

    The scene uses metres, Z up. Evaluated visible mesh objects must fit the
    200,000-triangle preview limit. Originals retain modifiers in the .blend.
    Failed exports never replace the previous preview; partial revisions may
    remain for diagnosis. This checks geometry validity, not print readiness.
    """
    directory = Path(model_directory).resolve()
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
