"""Regression for the joints kit: run with Blender --background --factory-startup --python-exit-code 1 --python tests/blender-joints.py."""
import runpy
import types
from pathlib import Path

import bmesh

root = Path(__file__).resolve().parents[1]
K = types.SimpleNamespace(**runpy.run_path(str(root / 'blender/rumi_joints.py')))


def open_edges(obj):
    """Edges that are not shared by exactly two faces after the validator's 0.001 mm weld."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    count = sum(1 for edge in bm.edges if not edge.is_manifold)
    bm.free()
    return count


def closed(*parts):
    for part in parts:
        assert open_edges(part) == 0, part.name + ' is not a closed solid'
        assert K.solids(part) == 1, part.name + ' is not one piece'


# Primitives are closed at an offset placement, where single precision once broke the exact solver.
K.start()
block = K.box('Block', (20, 20, 20), (-10, 50, 0))
K.join(block, K.cylinder('_post', 3, 12, (4, 50, 0), '+X'))
K.cut(block, K.lathe('_cone', [(0, 0), (4, 0), (0, 6)], (-10, 50, 10), '-Z'))
K.join(block, K.prism('_tee', [(0, 0), (6, 0), (6, 2), (4, 2), (4, 8), (2, 8), (2, 2), (0, 2)], 4, (-13, 50, 9.5), 'Y'))
closed(block)
low, high = K.bounds(block)
assert abs(high.x - 10) < 1e-3 and abs(low.x + 20) < 1e-3

# A wheel on a captive axle, on each side and axis the kart example uses.
for pivot, axis in (((40, -44, 14), '+X'), ((-40, 44, 14), '-X'), ((3, 7, 30), '+Z')):
    K.start()
    body = K.box('Body', (80, 120, 30), (0, 0, 15) if axis == '+Z' else (0, 0, 25))
    wheel = K.wheel('Wheel', pivot, axis, diameter=28, width=10, tread=12)
    record = K.captive_axle(body, wheel, pivot, axis, width=10, control='Wheel')
    closed(body, wheel)
    assert record['kind'] == 'revolute' and record['parent'] == 'Body' and record['child'] == 'Wheel'
    assert record['range'] == [-180.0, 180.0] and record['control'] == 'Wheel'
    assert [round(value, 6) for value in record['pivot']] == [float(value) for value in pivot]

# A door on a barrel hinge; the pin belongs to the body, the centre knuckle to the door.
K.start()
body = K.box('Body', (80, 120, 30), (0, 0, 25))
door = K.box2('Door', (40.5, -12, 14), (44.5, 18, 38))
record = K.barrel_hinge(body, door, (46.3, -20, 26), 'Z', '-X', '+Y', length=20, limits=(-110, 0), control='Door')
closed(body, door)
assert record['range'] == [-110.0, 0.0] and record['axis'] == [0.0, 0.0, 1.0]

# A part that does not reach the joint fails with an instruction, not a silently floating knuckle.
K.start()
body = K.box('Body', (80, 120, 30), (0, 0, 25))
door = K.box2('Door', (40.5, 0, 14), (44.5, 30, 38))
try:
    K.barrel_hinge(body, door, (46.3, -20, 26), 'Z', '-X', '+Y', length=20)
except ValueError as error:
    assert 'Bring the child' in str(error)
else:
    raise AssertionError('an unreachable door was accepted')

# Limits must contain the saved pose, and every part needs a joint.
try:
    K.joint('Bad', 'revolute', body, door, 'Z', (0, 0, 0), (10, 90))
except ValueError as error:
    assert 'contain 0' in str(error)
else:
    raise AssertionError('limits excluding the saved pose were accepted')
try:
    K.robot(body, [])
except ValueError as error:
    assert 'no joint' in str(error)
else:
    raise AssertionError('an unconnected part was accepted')

print('JOINTS_KIT_OK')
