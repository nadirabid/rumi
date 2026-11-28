"""Generate small solid and separately assembleable slider fixtures using the bundled build123d CAD publisher."""
from pathlib import Path
import runpy
import sys
import build123d as bd

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
output, helper = args[:2]
publish = runpy.run_path(helper)['publish']

block = bd.Pos(0, 0, 10) * bd.Box(20, 20, 20)
block.label = 'block'
solid_assembly = dict(
    version=1,
    root='block',
    parts=[dict(id='block', mesh='block')],
    connections=[],
    manufacturing=dict(mode='separate'),
)

# Separate sliding parts have a clear insertion route and production-sized clearance (0.3 mm) and walls (1.5 mm).
frame = bd.Box(40, 13.6, 13.6) - bd.Box(42, 10.6, 10.6)
frame.label = 'frame'
moving = bd.Box(16, 10.0, 10.0)
moving.label = 'moving'
slider_assembly = dict(
    version=1,
    root='frame',
    parts=[dict(id='frame', mesh='frame'), dict(id='moving', mesh='moving')],
    connections=[dict(id='slider', parent='frame', child='moving', kind='prismatic', axis=[1, 0, 0], pivot=[0, 0, 0], range=[-4, 4])],
    manufacturing=dict(mode='separate', steps=[dict(part='moving', path=[[0, 0, 0], [40, 0, 0]])]),
)

for name, parts, assembly in [('solid', [block], solid_assembly), ('slider', [frame, moving], slider_assembly)]:
    publish(str(Path(output) / name), parts, assembly=assembly, check=False)

print('VALIDATION_MODELS_READY')
