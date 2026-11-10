"""Millimetre modelling kit and printable joint recipes for Rumi Blender scripts.

Load with `K = types.SimpleNamespace(**runpy.run_path(joints_path))`. Every length, position and
pivot this module takes is in millimetres, Z up; it creates Blender geometry in metres. Objects keep
identity transforms and carry their placement in the mesh, which is what joint frames assume.

Recipes are starting points. Each cuts and adds the mating features on the two parts it is given and
returns the joint records that `publish` turns into the USD assembly. Recipes live in `joints/*.py`.
"""
import math
import runpy
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon

MM = 0.001
_HERE = Path(__file__).resolve().parent
_AXES = {'X': (1, 0, 0), 'Y': (0, 1, 0), 'Z': (0, 0, 1)}


def direction(value):
    """Return a unit vector for '+X', '-Z', 'Y' or an (x, y, z) tuple."""
    if isinstance(value, str):
        sign = -1 if value.startswith('-') else 1
        return Vector(_AXES[value.lstrip('+-').upper()]) * sign
    return Vector(value).normalized()


def frame(pivot, axis, xdir=None):
    """Matrix placing local Z on `axis` and local X on `xdir` (made perpendicular), origin at `pivot` in millimetres."""
    z = direction(axis)
    x = direction(xdir) if xdir is not None else (Vector((1, 0, 0)) if abs(z.x) < 0.9 else Vector((0, 1, 0)))
    x = (x - z * x.dot(z))
    if x.length < 1e-6:
        raise ValueError('xdir must not be parallel to the axis')
    x.normalize()
    y = z.cross(x)
    matrix = Matrix((x, y, z)).transposed().to_4x4()
    matrix.translation = Vector(pivot)
    return matrix


def start():
    """Empty the scene and set metric units. Call once at the top of a build script."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0


def _finish(name, bm, matrix=None):
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Scale(MM, 4), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _orient(axis):
    return Vector((0, 0, 1)).rotation_difference(direction(axis)).to_matrix().to_4x4()


def box(name, size, center=(0, 0, 0)):
    """Box with full `size` (x, y, z) centred at `center`."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    return _finish(name, bm, Matrix.Translation(center) @ Matrix.Diagonal((*size, 1)))


def box2(name, low, high):
    """Box from corner `low` to corner `high`."""
    low, high = Vector(low), Vector(high)
    return box(name, tuple(high - low), tuple((low + high) / 2))


def cylinder(name, radius, length, center=(0, 0, 0), axis='Z', radius2=None, segments=64):
    """Cylinder of `length` centred at `center` along `axis`; `radius2` makes a cone frustum (radius at the start, radius2 at the end)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius if radius2 is None else radius2, depth=length)
    return _finish(name, bm, Matrix.Translation(center) @ _orient(axis))


def rod(name, radius, start_point, end_point, radius2=None, segments=64):
    """Cylinder (or frustum) between two points."""
    a, b = Vector(start_point), Vector(end_point)
    return cylinder(name, radius, (b - a).length, tuple((a + b) / 2), tuple(b - a), radius2, segments)


def sphere(name, radius, center=(0, 0, 0), segments=48):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
    return _finish(name, bm, Matrix.Translation(center))


def prism(name, points, height, center=(0, 0, 0), axis='Z', xdir=None):
    """Extrude a simple closed 2D outline [(u, v), ...] by `height`, centred on `axis`. Concave outlines are fine.

    u runs along `xdir` (default: world X, or Y when the axis is X) and v completes the right-handed frame.
    """
    outline = []
    for u, v in points:
        if not outline or (Vector((u, v)) - Vector(outline[-1])).length > 1e-6:
            outline.append((u, v))
    if len(outline) > 1 and (Vector(outline[0]) - Vector(outline[-1])).length <= 1e-6:
        outline.pop()
    if len(outline) < 3:
        raise ValueError('prism: the outline needs at least three distinct points')
    points = outline
    bm = bmesh.new()
    low = [bm.verts.new((u, v, -height / 2)) for u, v in points]
    high = [bm.verts.new((u, v, height / 2)) for u, v in points]
    count = len(points)
    for a, b, c in tessellate_polygon([[Vector((u, v, 0)) for u, v in points]]):
        bm.faces.new((low[a], low[b], low[c]))
        bm.faces.new((high[a], high[b], high[c]))
    for i in range(count):
        bm.faces.new((low[i], low[(i + 1) % count], high[(i + 1) % count], high[i]))
    return _finish(name, bm, frame(center, axis, xdir))


def lathe(name, profile, center=(0, 0, 0), axis='Z', segments=64):
    """Revolve a closed profile [(radius, height), ...] around `axis` through `center`. Points may lie on the axis."""
    bm = bmesh.new()
    poles = {i: bm.verts.new((0, 0, z)) for i, (r, z) in enumerate(profile) if r <= 1e-9}
    rings = []
    for step in range(segments):
        angle = 2 * math.pi * step / segments
        rings.append([poles[i] if i in poles else bm.verts.new((r * math.cos(angle), r * math.sin(angle), z))
                      for i, (r, z) in enumerate(profile)])
    count = len(profile)
    for step in range(segments):
        for i in range(count):
            corners = []
            for vert in (rings[step][i], rings[(step + 1) % segments][i], rings[(step + 1) % segments][(i + 1) % count], rings[step][(i + 1) % count]):
                if vert not in corners:
                    corners.append(vert)
            if len(corners) >= 3:
                bm.faces.new(corners)
    return _finish(name, bm, Matrix.Translation(center) @ _orient(axis))


def _triangulate(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=[face for face in bm.faces if len(face.verts) > 3])
    bm.to_mesh(obj.data)
    bm.free()


def _clean(obj):
    """Weld at 0.001 mm and merge coplanar triangles so booleans leave no slivers for the geometry check."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=5e-6)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.05), verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=5e-6)
    slivers = [face for face in bm.faces if face.calc_area() < 1e-11]
    if slivers:
        bmesh.ops.triangulate(bm, faces=slivers)
        bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=2e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


def _boolean(target, tool, operation, keep):
    # Placed n-gons are no longer exactly planar in single precision; the exact solver needs triangles to classify them.
    _triangulate(target)
    _triangulate(tool)
    modifier = target.modifiers.new('rumi', 'BOOLEAN')
    modifier.operation, modifier.object, modifier.solver = operation, tool, 'EXACT'
    graph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(target.evaluated_get(graph))
    target.modifiers.remove(modifier)
    old = target.data
    for material in old.materials:
        if material and material.name not in [m.name for m in mesh.materials if m]:
            mesh.materials.append(material)
    target.data = mesh
    bpy.data.meshes.remove(old)
    _clean(target)
    if not keep:
        data = tool.data
        bpy.data.objects.remove(tool, do_unlink=True)
        bpy.data.meshes.remove(data)
    return target


def volume(obj):
    """Enclosed volume of the part in cubic millimetres."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    value = abs(bm.calc_volume()) / MM ** 3
    bm.free()
    return value


def cut(target, *tools, keep=False):
    """Subtract each tool from `target`. Tools are deleted unless keep=True."""
    for tool in tools:
        before = volume(target)
        _boolean(target, tool, 'DIFFERENCE', keep)
        if volume(target) > before * 1.000001 + 1e-3:
            raise ValueError('cut: subtracting from %s added material, so the Boolean failed. Check that both solids are closed and not coplanar.' % target.name)
    return target


def join(target, *others, keep=False):
    """Fuse the others into `target` as one solid. Each must overlap it; they are deleted afterwards."""
    for other in others:
        before = volume(target)
        _boolean(target, other, 'UNION', keep)
        if volume(target) < before * 0.999999 - 1e-3:
            raise ValueError('join: fusing into %s removed material, so the Boolean failed. Check that both solids are closed and not coplanar.' % target.name)
    return target


def common(target, tool, keep=False):
    """Keep only the volume `target` shares with `tool`."""
    return _boolean(target, tool, 'INTERSECT', keep)


def copy(obj, name):
    duplicate = bpy.data.objects.new(name, obj.data.copy())
    bpy.context.scene.collection.objects.link(duplicate)
    return duplicate


def discard(*objects):
    """Delete helper objects so they are not published."""
    for obj in objects:
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(data)


def move(obj, offset):
    obj.data.transform(Matrix.Translation(Vector(offset) * MM))
    return obj


def rotate(obj, axis, degrees, pivot=(0, 0, 0)):
    point = Vector(pivot) * MM
    obj.data.transform(Matrix.Translation(point) @ Matrix.Rotation(math.radians(degrees), 4, direction(axis)) @ Matrix.Translation(-point))
    return obj


def mirror(obj, axis, name=None):
    """Mirror across the plane through the origin normal to `axis`. With `name`, mirror a copy and return it."""
    target = copy(obj, name) if name else obj
    scale = [1, 1, 1]
    scale['XYZ'.index(axis.lstrip('+-').upper())] = -1
    target.data.transform(Matrix.Diagonal((*scale, 1)))
    target.data.flip_normals()
    return target


def place(obj, matrix):
    """Apply a millimetre placement matrix (from `frame`) to an object built at the origin."""
    scaled = matrix.copy()
    scaled.translation = matrix.translation * MM
    obj.data.transform(scaled)
    return obj


def paint(obj, rgba):
    """Give the part one surface colour (r, g, b) or (r, g, b, a), 0–1."""
    rgba = tuple(rgba) + (1,) * (4 - len(rgba))
    key = 'rumi_%02x%02x%02x' % tuple(int(round(c * 255)) for c in rgba[:3])
    material = bpy.data.materials.get(key)
    if material is None:
        material = bpy.data.materials.new(key)
        material.diffuse_color = rgba
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        if shader:
            shader.inputs['Base Color'].default_value = rgba
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def bounds(obj):
    """Return (low, high) corners of the part in millimetres."""
    points = [vertex.co / MM for vertex in obj.data.vertices]
    return (Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)]))


def solids(obj):
    """Number of disconnected pieces in the part's mesh. A printable part has exactly one."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, count = set(), 0
    for vert in bm.verts:
        if vert in seen:
            continue
        count += 1
        stack = [vert]
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(edge.other_vert(current) for edge in current.link_edges)
    bm.free()
    return count


def require_one_solid(obj, recipe, hint):
    """Fail loudly when a recipe's added feature did not fuse with the part it was meant to join."""
    count = solids(obj)
    if count != 1:
        raise ValueError('%s: %s is %d separate pieces after adding the joint. %s' % (recipe, obj.name, count, hint))


# ---------------------------------------------------------------- assembly

def joint(name, kind, parent, child, axis='Z', pivot=(0, 0, 0), limits=(0, 0), control=None):
    """Describe one connection. kind is 'revolute' (limits in degrees), 'prismatic' (limits in millimetres) or 'fixed'.

    The saved pose is position zero, so limits must contain 0.
    """
    if kind not in ('fixed', 'revolute', 'prismatic'):
        raise ValueError('kind must be fixed, revolute or prismatic')
    record = dict(id=name, kind=kind, parent=parent.name, child=child.name)
    if kind != 'fixed':
        low, high = float(limits[0]), float(limits[1])
        if not low <= 0 <= high:
            raise ValueError('%s: limits must contain 0, the saved pose' % name)
        record.update(axis=list(direction(axis)), pivot=[float(v) for v in pivot], range=[low, high])
        if control:
            record['control'] = control
    return record


def robot(root, joints, mode='print-in-place', sequences=()):
    """Return the `configure_robot` callback for the helper's publish: `root` is held, every other mesh must be a joint child.

    mode is 'print-in-place' (captive parts printed assembled) or 'separate' (printed apart and assembled).
    sequences is a list of dict(id=..., waypoints=[{joint_name: value}, ...]) for joints that only move together,
    in degrees or millimetres.
    """
    flat = []
    for item in joints:
        flat.extend(item if isinstance(item, (list, tuple)) else [item])
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.visible_get() and not obj.hide_render]
    children = {record['child'] for record in flat}
    loose = [obj.name for obj in meshes if obj is not root and obj.name not in children]
    if loose:
        raise ValueError('These parts have no joint connecting them to the assembly: ' + ', '.join(loose))
    order = [root] + [obj for obj in meshes if obj is not root]
    assembly = dict(version=1, root=root.name, parts=[dict(id=obj.name, mesh=obj.name) for obj in order],
                    connections=flat, sequences=[dict(item) for item in sequences], manufacturing=dict(mode=mode))
    migrate = runpy.run_path(str(_HERE / 'robot_usd.py'))['migrate_assembly']

    def configure_robot(stage):
        migrate(stage, assembly)
    return configure_robot


def publish(directory, root, joints=(), mode='print-in-place', sequences=()):
    """Publish the scene as `directory/model.usda` with its assembly, print `RUMI_CHECKS`, and return the helper's report.

    root is the part the checker holds still; joints is the list of records the recipes returned (nested lists are fine).
    """
    helper = runpy.run_path(str(_HERE / 'rumi_blender.py'))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if len(meshes) == 1 and not joints:
        return helper['publish'](directory)
    return helper['publish'](directory, configure_robot=robot(root, joints, mode, sequences))


def _load_recipes():
    namespace = dict(globals())
    recipes = {}
    for path in sorted((_HERE / 'joints').glob('*.py')):
        loaded = runpy.run_path(str(path), init_globals=namespace)
        for key, value in loaded.items():
            if callable(value) and not key.startswith('_') and key not in namespace:
                recipes[key] = value
    return recipes


globals().update(_load_recipes())
