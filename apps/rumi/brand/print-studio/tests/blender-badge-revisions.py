"""Publish labeled design revisions for the keyless badge receipt and live recognition checks."""
from pathlib import Path
import json
import hashlib
import runpy
import sys
import tempfile
import types

root = Path(__file__).resolve().parents[1]
kit = types.SimpleNamespace(**runpy.run_path(str(root / 'blender/rumi_joints.py')))
scratch = tempfile.TemporaryDirectory()
output = Path(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else Path(scratch.name)


def plate():
    kit.start()
    return kit.box2('Base', (-65, -64, -13), (65, 44, 0))


def save(case, root_part, joints, expected):
    """Check the actual immutable receipt; names are relative to the fixture project."""
    directory = output / case / 'models' / 'design'
    report = kit.publish(str(directory), root_part, joints, mode='separate' if joints else None)
    revision = Path(report['revisionUsd']).parent
    receipt = json.loads((revision / 'report.json').read_text())
    features = receipt.get('badgeFeatures', [])
    assert {feature['kind'] for feature in features} == set(expected), (case, features)
    assert all(set(feature['parts']).issubset(receipt['parts']) for feature in features)
    visible = directory / 'model.usda'
    assert visible.read_bytes() == (revision / 'model.usda').read_bytes()
    assert report['sourceHash'] == hashlib.sha256(visible.read_bytes()).hexdigest()
    info = visible.stat()
    assert report['savedFileStat'] == f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}'


base = plate()
for name, x in [('DriveGear', -22), ('DrivenGear', 22)]:
    kit.join(base, kit.cylinder(name, 11, 3, (x, 0, 1)))
save('plain', base, [], [])

base = plate()
wheel = kit.wheel('Roller', (0, 0, 0), 'Z', diameter=30, width=10)
axle = kit.captive_axle(base, wheel, (0, 0, 0), 'Z', snap=True)
save('wheel', base, [axle], ['wheel-and-axle'])
second = kit.wheel('DrivenGear', (40, 0, 0), 'Z', diameter=26, width=10)
other_axle = kit.captive_axle(base, second, (40, 0, 0), 'Z', snap=True)
save('independent', base, [axle, other_axle], ['wheel-and-axle'])

kit.start()
base = kit.box('Body', (80, 120, 30), (0, 0, 25))
lid = kit.box2('Lid', (40.5, -12, 14), (44.5, 18, 38))
hinge = kit.barrel_hinge(base, lid, (46.3, -20, 26), 'Z', '-X', '+Y', length=20, limits=(-110, 0))
save('barrel', base, [hinge], ['barrel-hinge'])

kit.start()
panel = kit.living_hinge('Panel', (0, 0, 0), 'Y')
save('fold', panel, [], ['living-hinge'])
panel.data.vertices[0].co.z += 0.004
save('modified', panel, [], [])

base = plate()
carriage = kit.box2('Carriage', (-8, -12, 0.4), (8, 12, 5.4))
slide = kit.dovetail_slide(base, carriage, (0, 0, 0), '+X', '+Z')
save('rail', base, [slide], ['dovetail-slide'])

base = plate()
gears = kit.gear_pair(base, (0, 0, 0), '+Z', 16, 20, toward='+X')
save('gears', base, gears, ['gear-pair'])
base = plate()
rack = kit.rack_pinion(base, (0, 0, 0), '+Z', '+X')
save('rack', base, rack, ['rack-and-pinion'])

kit.start()
outline = [(-22, 0), (22, 0), (22, 4), (4, 4), (1, 0.6), (-1, 0.6), (-4, 4), (-22, 4)]
custom = kit.prism('OnePiece', outline, 24, (0, 0, 0), 'Y', 'X')
save('custom-fold', custom, [], [])
kit.start()
engraved = [(x, 3.7 if z == 0.6 else z) for x, z in outline]
shallow = kit.prism('OnePiece', engraved, 24, (0, 0, 0), 'Y', 'X')
save('shallow-groove', shallow, [], [])
print('Badge fixture receipts match all eleven saved designs.')
