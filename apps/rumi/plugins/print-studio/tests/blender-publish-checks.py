"""Run with Blender --background --python-exit-code 1 --python tests/blender-publish-checks.py."""
import io
import json
from pathlib import Path
import runpy
import tempfile
from contextlib import redirect_stdout

import bpy

publish = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'blender/rumi_blender.py'))['publish']
settings = dict(minimumThicknessMm=1, degenerateThreshold=.000001, overhangDegrees=45,
                sharpDegrees=160, distortionDegrees=45, minimumClearanceMm=.2)


def two_cubes(gap_mm):
    """Two 10 mm cubes `gap_mm` apart along x, in metres."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=.01, location=(0, 0, 0))
    bpy.ops.mesh.primitive_cube_add(size=.01, location=((10 + gap_mm) / 1000, 0, 0))


def published(project, **options):
    """Publish into models/pair and return (report, printed lines)."""
    output = io.StringIO()
    with redirect_stdout(output):
        report = publish(str(project / 'models' / 'pair'), **options)
    return report, output.getvalue().splitlines()


with tempfile.TemporaryDirectory(prefix='rumi-publish-checks-') as directory:
    project = Path(directory).resolve()
    (project / 'models' / 'pair').mkdir(parents=True)

    two_cubes(.1)
    report, lines = published(project)
    missing = 'RUMI_CHECKS {"status":"unavailable","message":"Call blender_status in this project, then publish again."}'
    assert missing in lines, lines
    assert report['checks']['status'] == 'unavailable' and (project / 'models/pair/model.usda').is_file(), report

    (project / '.rumi').mkdir()
    (project / '.rumi' / 'print-checks.json').write_text(json.dumps(dict(version=1, settings=settings)))
    two_cubes(.1)
    report, lines = published(project)
    printed = [line for line in lines if line.startswith('RUMI_CHECKS ')]
    assert len(printed) == 1 and lines.index(printed[0]) > next(i for i, l in enumerate(lines) if l.startswith('RUMI_MODEL ')), lines
    checks = json.loads(printed[0][len('RUMI_CHECKS '):])
    assert checks == report['checks'], (checks, report['checks'])
    assert checks['status'] == 'needs_repair', checks
    clearance = next(item for item in checks['checks'] if item['code'] == 'insufficient_clearance')
    assert clearance['count'] == 1 and clearance['severity'] == 'error', clearance
    assert all(item['count'] > 0 for item in checks['checks']), checks
    assert abs(checks['dimensionsMm']['x'] - 20.1) < .05 and 'Bullet' in checks['note'], checks
    assert 'robot' not in checks and not any(key.startswith('prepared') for key in checks), checks
    assert not any((project / '.rumi' / 'tmp').iterdir()), 'scratch directory must be removed'

    two_cubes(1)
    report, _ = published(project)
    assert not any(item['code'] == 'insufficient_clearance' for item in report['checks']['checks']), report['checks']

    two_cubes(.1)
    report, lines = published(project, check=False)
    assert 'checks' not in report and not any(line.startswith('RUMI_CHECKS') for line in lines), lines
print('BLENDER_PUBLISH_CHECKS_OK: unavailable without settings, publish-time findings, opt-out')
