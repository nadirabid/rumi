"""Exercise publishing and cheap validation policy with real legacy USD, preserving old artifacts."""
from pathlib import Path
import runpy
import tempfile
from pxr import Usd
import bpy

root = Path(__file__).resolve().parents[1]
helper = runpy.run_path(str(root / 'blender/rumi_blender.py'))
kit = runpy.run_path(str(root / 'blender/rumi_joints.py'))
robot = runpy.run_path(str(root / 'blender/robot_usd.py'))
validator = runpy.run_path(str(root / 'blender/validate.py'))

with tempfile.TemporaryDirectory(prefix='rumi-separate-printing-') as directory:
    project = Path(directory)
    legacy = project / 'legacy.usda'
    legacy.write_text((root / 'tests/fixtures/robot.usda').read_text().replace(
        'rumi:manufacturingMode = "separate"', 'rumi:manufacturingMode = "print-in-place"'))
    report = validator['validate'](dict(input=str(legacy), stage='assembly'))
    assert report['status'] == 'needs_repair' and report['checks'][0]['code'] == 'separate_printing_required', report
    validator['toolbox'].unregister()
    description = robot['read_robot'](Usd.Stage.Open(str(legacy)))['assembly']
    assert description['manufacturing']['mode'] == 'print-in-place'
    bpy.ops.wm.read_factory_settings(use_empty=True)
    helper['import_mesh'](str(legacy))
    destination = project / 'models' / 'door'
    destination.mkdir(parents=True)
    canonical = destination / 'model.usda'
    canonical.write_text(legacy.read_text())
    before = canonical.read_bytes()
    try:
        helper['publish'](str(destination), check=False)
    except ValueError as error:
        assert 'Moving parts must be printed separately' in str(error)
    else:
        raise AssertionError('Legacy moving model was republished')
    assert canonical.read_bytes() == before
    body = bpy.data.objects[description['root']]
    for mode in (None, 'print-in-place'):
        try:
            kit['robot'](body, description['connections'], mode=mode)
        except ValueError as error:
            assert 'Moving parts must be printed separately' in str(error)
        else:
            raise AssertionError('Moving model accepted a missing or printed-assembled mode')
    # This fixture tests declaration round-tripping, not the physical feasibility of its hinge.
    configure = kit['robot'](body, description['connections'], mode='separate')
    assert callable(configure)
    result = helper['publish'](str(destination), configure_robot=lambda stage:
        stage.GetDefaultPrim().GetAttribute('rumi:manufacturingMode').Set('separate'), check=False)
    updated = robot['read_robot'](Usd.Stage.Open(result['preview']))['assembly']
    assert updated['manufacturing']['mode'] == 'separate'
    assert updated['connections'][0]['kind'] == 'revolute'
    assert updated['connections'][0]['range'] == description['connections'][0]['range']
    report = validator['validate'](dict(input=result['preview'], stage='assembly'))
    assert report['status'] == 'passed' and report['checks'] == [], report
    kit['start']()
    body = kit['box']('Base', (20, 20, 20), (0, 0, 0))
    door = kit['box']('Door', (10, 10, 10), (25, 0, 0))
    joint = kit['joint']('DoorHinge', 'revolute', body, door, 'Z', (15, 0, 0), (0, 90), 'Door')
    steps = [dict(part='Door', path=[[0, 0, 0], [0, 0, 30]])]
    configured = kit['robot'](body, [joint], mode='separate', steps=steps)
    result = helper['publish'](str(project / 'models' / 'declared-route'), configure_robot=configured, check=False)
    assert robot['read_robot'](Usd.Stage.Open(result['preview']))['assembly']['manufacturing']['steps'] == steps
print('SEPARATE_PRINTING_POLICY_OK')
