"""Check joint widget declarations through publish, Blender reopen, and republish."""
import json
import runpy
import tempfile
import types
from pathlib import Path

import bpy
from pxr import Usd

root = Path(__file__).resolve().parents[1]
K = types.SimpleNamespace(**runpy.run_path(str(root / 'blender/rumi_joints.py')))
helper = runpy.run_path(str(root / 'blender/rumi_blender.py'))
K.start()
base = K.box('Base', (10, 10, 10))
arm = K.box('Arm', (10, 10, 10), (20, 0, 0))
tip = K.box('Tip', (10, 10, 10), (40, 0, 0))
joints = [K.joint('Pan', 'revolute', base, arm, limits=(-90, 90)),
          K.joint('Slide', 'prismatic', arm, tip, 'X', limits=(0, 20))]
controls = [dict(kind='pad', label='Position', axes=[
    dict(joint='/Model/Joints/Pan', step=1), dict(joint='/Model/Joints/Slide', step=.25)])]

with tempfile.TemporaryDirectory(prefix='rumi-motion-controls-') as directory:
    K.publish(directory, root=base, joints=joints, mode='separate', controls=controls)
    stage = Usd.Stage.Open(str(Path(directory) / 'model.usda'))
    assert json.loads(stage.GetDefaultPrim().GetAttribute('rumi:motionControls').Get()) == controls
    blend = next((Path(directory) / 'revisions').glob('*/model.blend'))
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    helper['publish'](directory, check=False)
    stage = Usd.Stage.Open(str(Path(directory) / 'model.usda'))
    stage.Reload()
    assert json.loads(stage.GetDefaultPrim().GetAttribute('rumi:motionControls').Get()) == controls
    assert abs(stage.GetPrimAtPath('/Model/Joints/Slide').GetAttribute('physics:upperLimit').Get() - .02) < 1e-8
print('MOTION_CONTROLS_ROUNDTRIP_OK')
