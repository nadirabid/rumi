"""Verify CAD publishing, STEP/BREP export, RUMI_CHECKS, badge evidence, and control recipes."""
from __future__ import annotations

import hashlib
import io
import json
import runpy
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import build123d as bd

ROOT = Path(__file__).resolve().parents[1]
CAD = runpy.run_path(str(ROOT / 'cad/rumi_cad.py'))
USD = runpy.run_path(str(ROOT / 'cad/robot_usd.py'))
EVIDENCE = runpy.run_path(str(ROOT / 'cad/recipe_evidence.py'))

SETTINGS = {
    'minimumThicknessMm': 1.0,
    'degenerateThreshold': 1e-6,
    'overhangDegrees': 45.0,
    'sharpDegrees': 160.0,
    'distortionDegrees': 45.0,
    'minimumClearanceMm': 0.2,
}


def two_cubes(gap_mm: float):
    a = bd.Box(10, 10, 10)
    a.label = 'CubeA'
    a.color = (0.2, 0.5, 0.8, 1.0)
    b = bd.Pos(10.0 + gap_mm, 0, 0) * bd.Box(10, 10, 10)
    b.label = 'CubeB'
    b.color = (0.9, 0.3, 0.2, 1.0)
    return [a, b]


def do_publish(project: Path, parts, **options):
    output = io.StringIO()
    with redirect_stdout(output):
        report = CAD['publish'](project / 'models' / 'pair', parts, **options)
    return report, output.getvalue().splitlines()


with tempfile.TemporaryDirectory(prefix='rumi-cad-publish-') as tmp:
    project = Path(tmp).resolve()
    (project / 'models' / 'pair').mkdir(parents=True)

    # 1. Missing .rumi/print-checks.json -> unavailable RUMI_CHECKS, preview + STEP/BREP still saved.
    report, lines = do_publish(project, two_cubes(0.1))
    missing = 'RUMI_CHECKS {"status":"unavailable","message":"Call cad_status in this project, then publish again."}'
    assert missing in lines, lines
    assert report['checks']['status'] == 'unavailable', report
    assert (project / 'models/pair/model.usda').is_file()
    assert Path(report['step']).is_file() and Path(report['brep']).is_file()
    assert 'UsdPreviewSurface' in Path(report['preview']).read_text()
    assert 'rumi_3380cc' in Path(report['preview']).read_text()

    # Round-trip STEP and BREP import
    reloaded_step = CAD['import_step'](report['step'])
    assert abs(reloaded_step.volume - 2000.0) < 0.5, reloaded_step.volume
    reloaded_parts = CAD['import_brep'](Path(report['revisionUsd']).parent)
    assert len(reloaded_parts) == 2 and {p.label for p in reloaded_parts} == {'CubeA', 'CubeB'}

    # 2. With .rumi/print-checks.json -> subprocess validation runs and prints RUMI_CHECKS
    (project / '.rumi').mkdir()
    (project / '.rumi' / 'print-checks.json').write_text(json.dumps({'version': 1, 'settings': SETTINGS}))
    report, lines = do_publish(project, two_cubes(0.1))
    printed = [line for line in lines if line.startswith('RUMI_CHECKS ')]
    assert len(printed) == 1
    assert lines.index(printed[0]) > next(i for i, l in enumerate(lines) if l.startswith('RUMI_MODEL '))
    checks = json.loads(printed[0][len('RUMI_CHECKS '):])
    assert checks == report['checks'], (checks, report['checks'])
    assert checks['status'] == 'needs_repair', checks
    clearance = next(item for item in checks['checks'] if item['code'] == 'insufficient_clearance')
    assert clearance['count'] == 1 and clearance['severity'] == 'error', clearance
    assert all(item['count'] > 0 for item in checks['checks']), checks
    assert abs(checks['dimensionsMm']['x'] - 20.1) < 0.05 and 'Bullet' in checks['note'], checks
    assert 'robot' not in checks and not any(k.startswith('prepared') for k in checks), checks
    assert not any((project / '.rumi' / 'tmp').iterdir()), 'scratch directory must be removed'

    # 3. Clean 1.0 mm gap passes clearance
    report_ok, _ = do_publish(project, two_cubes(1.0))
    assert not any(item['code'] == 'insufficient_clearance' for item in report_ok['checks']['checks']), report_ok['checks']

    # 4. check=False skips RUMI_CHECKS
    report_nc, lines_nc = do_publish(project, two_cubes(0.1), check=False)
    assert 'checks' not in report_nc and not any(l.startswith('RUMI_CHECKS') for l in lines_nc), lines_nc

    # 5. Moving parts with mode='print-in-place' rejected without overwriting canonical preview
    canonical = project / 'models/pair/model.usda'
    before_bytes = canonical.read_bytes()
    bad_asm = {
        'version': 1, 'root': 'CubeA',
        'parts': [{'id': 'CubeA', 'mesh': 'CubeA'}, {'id': 'CubeB', 'mesh': 'CubeB'}],
        'connections': [{
            'id': 'Hinge', 'kind': 'revolute', 'parent': 'CubeA', 'child': 'CubeB',
            'axis': [0, 0, 1], 'pivot': [5, 0, 0], 'range': [0, 90],
        }],
        'manufacturing': {'mode': 'print-in-place'},
    }
    try:
        do_publish(project, two_cubes(1.0), assembly=bad_asm, check=False)
    except ValueError as err:
        assert 'Moving parts must be printed separately' in str(err)
    else:
        raise AssertionError('Moving assembly with print-in-place mode should fail')
    assert canonical.read_bytes() == before_bytes

    # 6. Badge recipe_evidence tracking: intact features saved, modified parts dropped
    parts = two_cubes(1.0)
    joint = {
        'id': 'WheelSpin', 'kind': 'revolute', 'parent': 'CubeA', 'child': 'CubeB',
        'axis': [0, 0, 1], 'pivot': [5, 0, 0], 'range': [-180, 180], 'control': 'Wheel',
    }
    EVIDENCE['record_feature']('wheel-and-axle', joint, {'CubeA': parts[0], 'CubeB': parts[1]})
    good_asm = {
        'version': 1, 'root': 'CubeA',
        'parts': [{'id': 'CubeA', 'mesh': 'CubeA'}, {'id': 'CubeB', 'mesh': 'CubeB'}],
        'connections': [joint],
        'manufacturing': {
            'mode': 'separate',
            'steps': [{'part': 'CubeB', 'actions': [{'kind': 'snap', 'delta': [20, 0, 0], 'maxInterferenceMm': 0.8, 'mate': 'CubeA'}]}],
        },
        'controls': [{'kind': 'slider', 'label': 'Wheel', 'axes': [{'joint': '/Model/Joints/WheelSpin'}]}],
    }
    rep_badge, _ = do_publish(project, parts, assembly=good_asm, check=False)
    receipt = json.loads((Path(rep_badge['revisionUsd']).parent / 'report.json').read_text())
    assert receipt['badgeFeatures'] == [{'kind': 'wheel-and-axle', 'parts': ['CubeA', 'CubeB'], 'joints': ['WheelSpin']}], receipt

    # Modify CubeB geometry -> badge evidence must NOT be awarded
    modified_b = parts[1] + bd.Pos(11, 0, 5) * bd.Box(2, 2, 2)
    modified_b.label = 'CubeB'
    modified_b._rumi_features = parts[1]._rumi_features
    rep_mod, _ = do_publish(project, [parts[0], modified_b], assembly=good_asm, check=False)
    receipt_mod = json.loads((Path(rep_mod['revisionUsd']).parent / 'report.json').read_text())
    assert 'badgeFeatures' not in receipt_mod, receipt_mod

    # 6b. Multi-instance badge evidence: 4 wheels attached sequentially to the same Body (mutating Body each time)
    body = bd.Box(60, 30, 12)
    body.label = 'Body'
    wheel_specs = [
        ('FrontLeftWheel', 'FrontLeftCap', -20, 18, 1),
        ('FrontRightWheel', 'FrontRightCap', -20, -18, -1),
        ('RearLeftWheel', 'RearLeftCap', 20, 18, 1),
        ('RearRightWheel', 'RearRightCap', 20, -18, -1),
    ]
    car_parts = []
    car_conns = []
    car_feats = []
    for w_name, c_name, wx, wy, sign in wheel_specs:
        # Mutate Body by fusing an axle boss, just like 4 sequential bayonet_axle calls
        body = body + (bd.Pos(wx, sign * 17, 0) * bd.Rot(90, 0, 0) * bd.Cylinder(3, 6))
        body.label = 'Body'
        w = bd.Pos(wx, wy + sign * 3, 0) * bd.Rot(90, 0, 0) * bd.Cylinder(8, 5)
        w.label = w_name
        c = bd.Pos(wx, wy + sign * 8, 0) * bd.Rot(90, 0, 0) * bd.Cylinder(5, 3)
        c.label = c_name
        rev = {'id': w_name + 'Axle', 'kind': 'revolute', 'parent': 'Body', 'child': w_name,
               'axis': [0, sign, 0], 'pivot': [wx, wy, 0], 'range': [-180, 180]}
        lock = {'id': c_name + 'Lock', 'kind': 'fixed', 'parent': 'Body', 'child': c_name,
                'retainer': 'bayonet', 'axis': [0, sign, 0], 'pivot': [wx, wy, 0]}
        car_parts.extend([w, c])
        car_conns.extend([rev, lock])
        car_feats.append(EVIDENCE['make_feature']('wheel-and-axle', {'Body': body, w_name: w, c_name: c}, [rev, lock]))

    all_car_parts = [body, *car_parts]
    car_asm = {
        'version': 1, 'root': 'Body',
        'parts': [{'id': p.label, 'mesh': p.label} for p in all_car_parts],
        'connections': car_conns,
        'manufacturing': {'mode': 'separate'},
    }
    rep_car, _ = do_publish(project, all_car_parts, assembly=car_asm, features=car_feats, check=False)
    car_receipt = json.loads((Path(rep_car['revisionUsd']).parent / 'report.json').read_text())
    car_badges = car_receipt.get('badgeFeatures', [])
    assert len(car_badges) == 4, car_badges
    assert all(f['kind'] == 'wheel-and-axle' for f in car_badges), car_badges
    assert {f['parts'][1] for f in car_badges} == {s[0] for s in wheel_specs}, car_badges

    # Mutating 1 wheel invalidates only that 1 feature, preserving the other 3
    tampered_w = car_parts[0] + bd.Pos(-20, 21, 8) * bd.Box(2, 2, 2)
    tampered_w.label = car_parts[0].label
    rep_car3, _ = do_publish(project, [body, tampered_w, *car_parts[1:]], assembly=car_asm, features=car_feats, check=False)
    car3_badges = json.loads((Path(rep_car3['revisionUsd']).parent / 'report.json').read_text()).get('badgeFeatures', [])
    assert len(car3_badges) == 3 and 'FrontLeftWheel' not in {f['parts'][1] for f in car3_badges}, car3_badges

    # Mutating shared Body after all 4 recipes invalidates all 4 features
    tampered_body = body + bd.Pos(0, 0, 10) * bd.Box(5, 5, 5)
    tampered_body.label = 'Body'
    rep_car0, _ = do_publish(project, [tampered_body, *car_parts], assembly=car_asm, features=car_feats, check=False)
    car0_receipt = json.loads((Path(rep_car0['revisionUsd']).parent / 'report.json').read_text())
    assert 'badgeFeatures' not in car0_receipt, car0_receipt

    # 7. Exact B-Rep cut_solid + load_control_recipe + summarize_control_recipe
    src_usd = Path(rep_badge['preview'])
    cut_recipe = {
        'version': 1,
        'frozen': True,
        'operation': 'cut',
        'source': str(src_usd),
        'sourceHash': hashlib.sha256(src_usd.read_bytes()).hexdigest(),
        'parts': ['CubeA'],
        'center': [0.0, 0.0, 0.0],
        'radii': [10.0, 10.0, 10.0],
        'direction': [0.0, 0.0, 1.0],
        'limit': 5.0,
        'values': {'amount': 0.5, 'spread': 0.5, 'peakX': 0.5, 'peakY': 0.5, 'falloff': 0.5, 'angle': 0.5},
    }
    recipe_file = project / 'cut-recipe.json'
    recipe_file.write_text(json.dumps(cut_recipe))
    loaded = CAD['load_control_recipe'](recipe_file)
    trimmed = CAD['cut_solid'](parts[0], loaded)
    assert abs(trimmed.volume - 500.0) < 0.5, trimmed.volume
    assert trimmed.label == 'CubeA'
    cut_summary = CAD['summarize_control_recipe'](loaded)
    assert cut_summary['exactBRepHelper'] == 'cut_solid(part, recipe)'
    assert cut_summary['plane']['retainedNormal'] == [0.0, 0.0, 1.0]

    bulge_recipe = dict(cut_recipe, operation='bulge', values={'amount': 0.8, 'spread': 0.5, 'peakX': 0.5, 'peakY': 0.5, 'falloff': 0.5, 'angle': 0.5})
    bulge_summary = CAD['summarize_control_recipe'](bulge_recipe)
    assert bulge_summary['operation'] == 'bulge' and abs(bulge_summary['amplitudeMm'] - 3.0) < 1e-3, bulge_summary

    # Multi-color B-Rep face splitting, painting, region painters, and lossless B-Rep round-trip
    block = bd.fillet(bd.Box(30, 20, 24).edges(), 2.0)
    block.label = 'ColorBlock'
    block.color = bd.Color(0.10, 0.35, 0.75)
    split_block = CAD['split_faces'](block, bd.Plane.XY.offset(-4.0), bd.Plane.XY.offset(4.0))
    assert len(split_block.solids()) == 1
    assert abs(split_block.volume - block.volume) < 0.05
    assert len(split_block.faces()) > len(block.faces())
    CAD['paint_faces'](split_block, lambda f: f.center().Z > 4.0, '#d72430')
    CAD['paint_faces'](split_block, lambda f: f.center().Z < -4.0, '#ffffff')

    color_dir = project / 'models' / 'multicolor'
    color_report = CAD['publish'](color_dir, [split_block], check=True)
    color_usd = (color_dir / 'model.usda').read_text(encoding='utf-8')
    assert 'def GeomSubset "rumi_d72430"' in color_usd, 'missing red GeomSubset'
    assert 'def GeomSubset "rumi_ffffff"' in color_usd, 'missing white GeomSubset'
    assert 'def GeomSubset "rumi_1a59bf"' in color_usd, 'missing blue base GeomSubset'
    # Multi-subset meshes must not emit mesh-level displayColor (which overrides pure-white subsets in Three.js)
    mesh_section = color_usd[color_usd.index('def Mesh "ColorBlock"'):]
    assert 'primvars:displayColor' not in mesh_section, 'unexpected displayColor on multi-subset mesh'
    parsed_color = CAD['_robot_usd']['parse_usda'](color_usd)
    subsets = [p for p in parsed_color['prims'].values() if p['type'] == 'GeomSubset']
    covered = sorted(idx for s in subsets for idx in s['attrs']['indices']['value'])
    assert covered == list(range(color_report['triangles'])), 'GeomSubsets must partition all triangles exactly once'
    assert color_report['checks']['status'] in ('passed', 'review'), color_report['checks']
    assert all(c['severity'] != 'error' for c in color_report['checks']['checks']), color_report['checks']

    # Verify assembly.json + import_brep restores face colors losslessly
    rev_dir = Path(color_report['revisionUsd']).parent
    reimported = CAD['import_brep'](rev_dir)
    assert len(reimported) == 1
    assert len(getattr(reimported[0], '_rumi_face_colors', ())) > 0
    repub_dir = project / 'models' / 'multicolor-repub'
    CAD['publish'](repub_dir, reimported, check=False)
    repub_usd = (repub_dir / 'model.usda').read_text(encoding='utf-8')
    assert 'def GeomSubset "rumi_d72430"' in repub_usd and 'def GeomSubset "rumi_ffffff"' in repub_usd

    # Verify joints kit helpers: K.split_faces, K.paint_faces, K.paint_regions, K.copy, and single-color collapse
    import types
    import numpy as np
    K = types.SimpleNamespace(**runpy.run_path(str(ROOT / 'cad/rumi_joints.py')))
    K.start()
    kit_part = K.box('PaintedBox', (20, 20, 20), (0, 0, 10))
    K.paint(kit_part, '#2060c0')
    K.split_faces(kit_part, bd.Plane.XY.offset(10.0))
    K.paint_faces(kit_part, lambda f: f.center().Z > 10.0, '#e03030')

    def stripe_painter(centroids, normals):
        out = np.full((len(centroids), 3), np.nan, dtype=np.float64)
        mask = (centroids[:, 0] > 0.0) & (centroids[:, 2] < 10.0)
        out[mask] = (0.95, 0.80, 0.10)
        return out

    K.paint_regions(kit_part, stripe_painter)
    dup = K.copy(kit_part, 'CopiedBox')
    K.move(dup, (40, 0, 0))
    K.discard(dup)
    kit_dir = project / 'models' / 'kit-painted'
    kit_report = K.publish(kit_dir, parts=[kit_part], root=kit_part, check=True)
    kit_usd = (kit_dir / 'model.usda').read_text(encoding='utf-8')
    assert 'def GeomSubset "rumi_e03030"' in kit_usd
    assert 'def GeomSubset "rumi_f2cc1a"' in kit_usd
    assert 'def GeomSubset "rumi_2060c0"' in kit_usd
    assert kit_report['checks']['status'] == 'passed', kit_report['checks']
    assert all(c['severity'] != 'error' for c in kit_report['checks']['checks']), kit_report['checks']

    # Single-color paint_faces collapses cleanly without GeomSubset overhead
    uni = bd.Box(12, 12, 12)
    uni.label = 'UniBox'
    uni.color = bd.Color(0.2, 0.4, 0.6)
    CAD['paint_faces'](uni, lambda f: True, (0.2, 0.4, 0.6))
    uni_dir = project / 'models' / 'unibox'
    CAD['publish'](uni_dir, [uni], check=False)
    uni_usd = (uni_dir / 'model.usda').read_text(encoding='utf-8')
    assert 'GeomSubset' not in uni_usd
    assert 'primvars:displayColor' in uni_usd

print('CAD_PUBLISH_CHECKS_OK: STEP/BREP/USD publish, RUMI_CHECKS, badges, multi-color GeomSubsets, and B-Rep control recipes')
