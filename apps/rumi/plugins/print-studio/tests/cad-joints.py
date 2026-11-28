"""End-to-end verification of the build123d separate-print joints kit against cad/validate.py and rumi-bullet.

Run with:
  PYTHONDONTWRITEBYTECODE=1 apps/rumi/.desktop-build/dev-cad/bin/python \
    apps/rumi/plugins/print-studio/tests/cad-joints.py
"""
from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[3]
CAD_DIR = ROOT / 'cad'
BULLET_BIN = Path(os.environ.get('RUMI_BULLET_BIN', str(REPO / 'apps/rumi/.desktop-build/dev-bullet/rumi-bullet')))

K = types.SimpleNamespace(**runpy.run_path(str(CAD_DIR / 'rumi_joints.py')))
VALIDATE = runpy.run_path(str(CAD_DIR / 'validate.py'))

VALIDATE_SETTINGS = {
    'minimumThicknessMm': 1.0,
    'minimumClearanceMm': 0.3,
    'degenerateThreshold': 1e-6,
    'overhangDegrees': 45.0,
    'sharpDegrees': 160.0,
    'distortionDegrees': 45.0,
}

BULLET_SETTINGS = {
    'maxTotalSteps': 2000000,
    'retentionWorkers': 4,
    'timeStepSeconds': 0.00025,
    'iterations': 40,
    'probeDurationSeconds': 0.25,
    'restDurationSeconds': 0.02,
    'retentionDurationSeconds': 0.05,
    'densityKgM3': 1250,
    'forceN': 1.0,
    'torqueNm': 0.05,
    'linearToleranceMm': 0.5,
    'angularToleranceDegrees': 5.0,
    'initialPenetrationMm': 0.15,
    'maxPenetrationMm': 0.35,
    'retentionTravelMm': 2.0,
    'retentionTiltDegrees': 15.0,
    'gravityMps2': [0, 0, -9.81],
    'friction': 0.2,
    'movementSampleDegrees': 30,
    'movementSampleMm': 2.0,
    'assemblySampleMm': 0.2,
    'assemblySampleDegrees': 5.0,
}


def run_bullet(mechanics_json: dict, settings_override: dict | None = None) -> dict:
    assert BULLET_BIN.is_file(), f'rumi-bullet binary not found at {BULLET_BIN}'
    settings = dict(BULLET_SETTINGS)
    if settings_override:
        settings.update(settings_override)
    payload = {
        'version': 2,
        'settings': settings,
        'bodies': mechanics_json['bodies'],
        'assembly': mechanics_json['assembly'],
    }
    proc = subprocess.run(
        [str(BULLET_BIN)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        timeout=240,
    )
    assert proc.stdout.strip(), f'rumi-bullet produced no output (rc={proc.returncode}, stderr={proc.stderr})'
    return json.loads(proc.stdout)


def verify_recipe(
    tmp: Path,
    label: str,
    build_fn,
    *,
    expect_bullet: str = 'passed',
    expect_badge: str | None = None,
    expect_badge_count: int | None = None,
    gravity: list[float] | None = None,
    allow_validate_warnings: bool = True,
    bullet_settings: dict | None = None,
) -> dict:
    """Build, publish, run cad/validate.py, and run rumi-bullet on one recipe."""
    t0 = time.monotonic()
    K.start()
    model_dir = tmp / label
    project_dir = tmp
    (project_dir / '.rumi').mkdir(exist_ok=True)
    (project_dir / '.rumi' / 'print-checks.json').write_text(json.dumps({'settings': VALIDATE_SETTINGS}))

    spec = build_fn()
    receipt = K.publish(
        model_dir,
        spec.get('parts'),
        spec['root'],
        joints=spec.get('joints', ()),
        mode=spec.get('mode', 'separate'),
        sequences=spec.get('sequences', ()),
        steps=spec.get('steps'),
        controls=spec.get('controls'),
        check=False,
    )

    assert Path(receipt['preview']).is_file(), f'{label}: missing model.usda'
    assert Path(receipt['step']).is_file(), f'{label}: missing model.step'

    if expect_badge is not None:
        report_json = json.loads(Path(receipt['revisionUsd']).with_name('report.json').read_text())
        badges = [f['kind'] for f in report_json.get('badgeFeatures', ())]
        assert expect_badge in badges, f'{label}: expected badge {expect_badge!r} in report.json, got {badges}'
        if expect_badge_count is not None:
            actual_count = sum(1 for b in badges if b == expect_badge)
            assert actual_count == expect_badge_count, (
                f'{label}: expected {expect_badge_count} {expect_badge!r} badges in report.json, got {actual_count} ({badges})'
            )

    mech_path = model_dir / 'mechanics.json'
    val_req = {
        'input': receipt['revisionUsd'],
        'settings': VALIDATE_SETTINGS,
        'stage': 'all',
        'volume': {'x': 300, 'y': 320, 'z': 320},
    }
    if expect_bullet != 'skip':
        val_req['mechanicsOutput'] = str(mech_path)
    val_report = VALIDATE['validate'](val_req)
    errors = [c for c in val_report['checks'] if c.get('severity') == 'error' and c.get('count', 0) > 0]
    assert not errors, f'{label}: cad/validate.py errors: {json.dumps(errors, indent=2)}'
    if not allow_validate_warnings:
        assert val_report['status'] == 'passed', f'{label}: cad/validate.py status={val_report["status"]}: {val_report["checks"]}'

    bullet_res = None
    if expect_bullet != 'skip':
        mech_data = json.loads(mech_path.read_text())
        ov = dict(bullet_settings or {})
        if gravity is not None:
            ov['gravityMps2'] = gravity
        bullet_res = run_bullet(mech_data, settings_override=ov)
        if expect_bullet == 'passed':
            assert bullet_res.get('status') == 'passed' and bullet_res.get('assemblyVerified') is True, (
                f'{label}: rumi-bullet failed (status={bullet_res.get("status")}, '
                f'verified={bullet_res.get("assemblyVerified")}): {json.dumps(bullet_res.get("checks"), indent=2)}'
            )
            # Every non-root part must be covered in assemblySteps.
            non_root = {p['id'] for p in mech_data['assembly']['parts'] if p['id'] != mech_data['assembly']['root']}
            covered = set(bullet_res.get('coverage', {}).get('assemblySteps', ()))
            assert covered == non_root, f'{label}: assemblySteps {covered} != non_root {non_root}'
        elif expect_bullet == 'friction':
            codes = {c['code'] for c in bullet_res.get('checks', ())}
            assert 'retainer_unverified_friction' in codes, f'{label}: expected retainer_unverified_friction, got {codes}'
            assert bullet_res.get('status') == 'review', f'{label}: expected status=review for friction retainer, got {bullet_res}'
            # No hard repair errors allowed even on friction fasteners.
            hard_errors = [c for c in bullet_res.get('checks', ()) if c.get('severity') == 'error']
            assert not hard_errors, f'{label}: unexpected hard errors on friction recipe: {hard_errors}'

    dt = time.monotonic() - t0
    print(f'  [OK] {label:<22s} parts={len(receipt["parts"]):<2d} tris={receipt["triangles"]:<6d} bullet={expect_bullet:<8s} ({dt:.2f}s)')
    return {'receipt': receipt, 'validate': val_report, 'bullet': bullet_res}


def test_primitives_and_ops():
    """Verify all B-Rep primitives, CAD ops, transforms, bounds, solids, and outline_distances."""
    K.start()
    block = K.box('Block', (20, 20, 20), (-10, 50, 0))
    K.join(block, K.cylinder('_post', 3, 12, (4, 50, 0), '+X'))
    K.cut(block, K.lathe('_cone', [(0, 0), (4, 0), (0, 6)], (-10, 50, 10), '-Z'))
    K.join(block, K.prism('_tee', [(0, 0), (6, 0), (6, 2), (4, 2), (4, 8), (2, 8), (2, 2), (0, 2)], 4, (-13, 50, 9.5), 'Y'))
    K.join(block, K.rod('_rod', 2.0, (-10, 50, -10), (-10, 50, -16)))
    K.join(block, K.sphere('_ball', 3.0, (-10, 50, -16)))
    K.require_one_solid(block, 'primitives', 'Block must stay one solid')
    lo, hi = K.bounds(block)
    assert abs(hi.x - 10.0) < 1e-3 and abs(lo.x + 20.0) < 1e-3
    assert K.volume(block) > 7500.0

    # Fillet, chamfer, copy, mirror, move, rotate, paint, common.
    c = K.box('Cube', (10, 10, 10), (20, 0, 0))
    v0 = K.volume(c)
    K.fillet(c, 1.0)
    assert K.volume(c) < v0 and K.solids(c) == 1
    c2 = K.box('Chamf', (10, 10, 10), (40, 0, 0))
    K.chamfer(c2, 1.0)
    assert K.volume(c2) < v0 and K.solids(c2) == 1
    c_dup = K.copy(c, 'CubeDup')
    K.move(c_dup, (0, 20, 0))
    K.rotate(c_dup, 'Z', 45, pivot=(20, 20, 0))
    c_mir = K.mirror(c, 'X', name='CubeMir')
    assert K.bounds(c_mir)[1].x < -14.0
    K.paint(c, (0.2, 0.5, 0.9))
    assert c.color == (0.2, 0.5, 0.9, 1.0)

    # Public K.register() for custom build123d shapes.
    raw_shape = K.b3d.Box(8, 6, 4)
    custom = K.register('CustomPart', raw_shape, color=(0.8, 0.3, 0.2))
    assert K.part('CustomPart') is custom and custom.color == (0.8, 0.3, 0.2, 1.0)
    assert abs(K.volume(custom) - 192.0) < 1e-3 and K.solids(custom) == 1
    K.discard(custom)

    # outline_distances check
    dists = K.outline_distances([(0, 0), (5, 0)], [[(0, -1), (0, 1), (-2, 1), (-2, -1)]])
    assert abs(dists[0] - 0.0) < 1e-9 and abs(dists[1] - 5.0) < 1e-9
    print('  [OK] primitives_and_ops')


def test_negative_cases(tmp: Path):
    """Verify invalid modes, trapped print-in-place parts, loose unretained parts, colliding routes, and missing steps are rejected."""
    # 1. Print-in-place mode rejected for moving joints.
    K.start()
    body = K.box('Body', (40, 40, 20), (0, 0, 10))
    w = K.wheel('Wheel', (20, 0, 10), '+X', diameter=28, width=10)
    res = K.bayonet_axle(body, w, (20, 0, 10), '+X', width=10)
    try:
        K.publish(tmp / 'neg-pip-mode', [body, w], body, joints=[res], mode='print-in-place', check=False)
    except ValueError as err:
        assert 'printed separately' in str(err)
    else:
        raise AssertionError('print-in-place mode was not rejected')

    # 2. Limits excluding 0 rejected.
    try:
        K.joint('BadLim', 'revolute', body, w, '+X', (20, 0, 10), (10, 90))
    except ValueError as err:
        assert 'contain 0' in str(err)
    else:
        raise AssertionError('limits excluding 0 were not rejected')

    # 3. Disconnected part rejected.
    K.start()
    a = K.box('A', (20, 20, 20), (0, 0, 10))
    b = K.box('B', (10, 10, 10), (40, 0, 10))
    try:
        K.assembly([a, b], a, joints=[])
    except ValueError as err:
        assert 'no joint' in str(err)
    else:
        raise AssertionError('disconnected part was not rejected')

    # 4. Print-in-place trapped wheel (integral solid flange head, cannot slide off) REJECTED by rumi-bullet!
    K.start()
    base = K.box('Base', (30, 30, 20), (0, 0, 10))
    trapped_wheel = K.cylinder('TrappedWheel', 14, 8, (0, 0, 25.4))
    K.cut(trapped_wheel, K.cylinder('_wbore', 4.35, 14, (0, 0, 25.4)))
    # Integral solid flange wider than wheel bore fused directly onto base!
    K.join(
        base,
        K.cylinder('_shaft', 4.0, 14.0, (0, 0, 26.0)),
        K.cylinder('_shoulder', 7.0, 2.0, (0, 0, 20.0)),
        K.cylinder('_trapped_head', 7.0, 2.5, (0, 0, 31.0)),
    )
    j = K.joint('TrappedAxle', 'revolute', base, trapped_wheel, '+Z', (0, 0, 20), (-180, 180))
    steps = [K.step_translate(trapped_wheel, (0, 0, 40))]
    rec = K.publish(tmp / 'neg-trapped', [base, trapped_wheel], base, joints=[j], mode='separate', steps=steps, check=False)
    mp = tmp / 'neg-trapped' / 'mech.json'
    VALIDATE['validate']({'input': rec['revisionUsd'], 'settings': VALIDATE_SETTINGS, 'stage': 'all', 'mechanicsOutput': str(mp)})
    b_res = run_bullet(json.loads(mp.read_text()))
    codes = {c['code'] for c in b_res.get('checks', ())}
    assert b_res['status'] == 'needs_repair' and 'assembly_path_interference' in codes, f'trapped wheel should fail disassembly: {b_res}'

    # 5. Unretained loose wheel (horizontal +X axle, no cap at all) REJECTED by rumi-bullet!
    K.start()
    base = K.box('Base', (30, 30, 24), (0, 0, 12))
    loose_w = K.cylinder('LooseWheel', 14, 8, (20.4, 0, 12), axis='+X')
    K.cut(loose_w, K.cylinder('_wbore', 4.35, 14, (20.4, 0, 12), axis='+X'))
    K.join(base, K.cylinder('_shaft', 4.0, 12.0, (20.0, 0, 12), axis='+X'), K.cylinder('_shoulder', 7.0, 2.0, (15.0, 0, 12), axis='+X'))
    j = K.joint('LooseAxle', 'revolute', base, loose_w, '+X', (15, 0, 12), (-180, 180))
    rec = K.publish(tmp / 'neg-loose', [base, loose_w], base, joints=[j], mode='separate', steps=[K.step_translate(loose_w, (40, 0, 0))], check=False)
    mp = tmp / 'neg-loose' / 'mech.json'
    VALIDATE['validate']({'input': rec['revisionUsd'], 'settings': VALIDATE_SETTINGS, 'stage': 'all', 'mechanicsOutput': str(mp)})
    b_res = run_bullet(json.loads(mp.read_text()))
    codes = {c['code'] for c in b_res.get('checks', ())}
    assert b_res['status'] == 'needs_repair' and 'unretained_part' in codes, f'loose wheel should fail retention: {b_res}'

    # 6. Colliding twist path (twisting bayonet cap the WRONG way +90 instead of -90) REJECTED by rumi-bullet!
    K.start()
    base = K.box('Base', (40, 40, 20), (0, 0, 10))
    w = K.wheel('Wheel', (0, 0, 20), '+Z', diameter=28, width=10)
    res = K.bayonet_axle(base, w, (0, 0, 20), '+Z', width=10)
    bad_steps = [
        K.step_twist(res.cap, (0, 0, 20), '+Z', +90.0, pull=(0, 0, 40)),  # wrong direction!
        K.step_translate(w, (0, 0, 50)),
    ]
    rec = K.publish(tmp / 'neg-bad-twist', [base, w], base, joints=[res], mode='separate', steps=bad_steps, check=False)
    mp = tmp / 'neg-bad-twist' / 'mech.json'
    VALIDATE['validate']({'input': rec['revisionUsd'], 'settings': VALIDATE_SETTINGS, 'stage': 'all', 'mechanicsOutput': str(mp)})
    b_res = run_bullet(json.loads(mp.read_text()))
    codes = {c['code'] for c in b_res.get('checks', ())}
    assert b_res['status'] == 'needs_repair' and 'assembly_path_interference' in codes, f'wrong twist should collide: {b_res}'

    # 7. Colliding snap path (maxInterferenceMm smaller than barb) REJECTED by rumi-bullet!
    K.start()
    base = K.box('Base', (60, 40, 24), (0, 0, 12))
    w = K.wheel('Wheel', (30, 0, 12), '+X', diameter=28, width=10)
    res = K.snap_axle(base, w, (30, 0, 12), '+X', width=10, barb=1.0)
    bad_snap = [K.step_snap(w, (18, 0, 0), max_interference_mm=0.2, pull=(30, 0, 0), mate=base)]
    rec = K.publish(tmp / 'neg-bad-snap', [base, w], base, joints=[res], mode='separate', steps=bad_snap, check=False)
    mp = tmp / 'neg-bad-snap' / 'mech.json'
    VALIDATE['validate']({'input': rec['revisionUsd'], 'settings': VALIDATE_SETTINGS, 'stage': 'all', 'mechanicsOutput': str(mp)})
    b_res = run_bullet(json.loads(mp.read_text()))
    codes = {c['code'] for c in b_res.get('checks', ())}
    assert b_res['status'] == 'needs_repair' and 'assembly_path_interference' in codes, f'tight snap limit should fail: {b_res}'

    # 8. Missing disassembly steps leave assemblySteps empty (unverified for acceptance).
    K.start()
    base = K.box('Base', (40, 40, 20), (0, 0, 10))
    w = K.wheel('Wheel', (0, 0, 20), '+Z', diameter=28, width=10)
    res = K.bayonet_axle(base, w, (0, 0, 20), '+Z', width=10)
    # Publish raw joints without steps so rumi:disassembly is omitted.
    rec = K.publish(tmp / 'neg-no-steps', [base, w, res.cap], base, joints=list(res.joints), mode='separate', steps=None, check=False)
    mp = tmp / 'neg-no-steps' / 'mech.json'
    VALIDATE['validate']({'input': rec['revisionUsd'], 'settings': VALIDATE_SETTINGS, 'stage': 'all', 'mechanicsOutput': str(mp)})
    b_res = run_bullet(json.loads(mp.read_text()))
    assert b_res.get('coverage', {}).get('assemblySteps') == [], f'missing steps should report empty assemblySteps: {b_res}'

    print('  [OK] negative_cases (8/8 rejections verified)')


def main(only: list[str] | None = None):
    assert BULLET_BIN.is_file(), f'Missing rumi-bullet binary: {BULLET_BIN}'
    selected = set(only if only is not None else sys.argv[1:])
    print(f'Testing build123d separate-print joints kit against cad/validate.py and {BULLET_BIN}...')

    def want(name: str) -> bool:
        return not selected or name in selected

    def run_recipe(tmp: Path, label: str, build_fn, **kwargs):
        if want(label):
            return verify_recipe(tmp, label, build_fn, **kwargs)
        return None

    with tempfile.TemporaryDirectory(prefix='rumi-cad-joints-') as tmp_str:
        tmp = Path(tmp_str)
        if want('primitives_and_ops'):
            test_primitives_and_ops()

        # ---------------- WHEELS ----------------
        def build_bayonet_axle():
            body = K.box('Body', (60, 40, 24), (0, 0, 12))
            w = K.wheel('Wheel', (30, 0, 12), '+X', diameter=28, width=10, tread=12)
            res = K.bayonet_axle(body, w, (30, 0, 12), '+X', width=10, control='Wheel')
            # Default recess=None recesses width=10 wheels so the cap sits compact (< 4.5 mm proud vs ~8.9 mm external).
            w_hi = K.bounds(w)[1].x
            cap_hi = K.bounds(res.cap)[1].x
            assert cap_hi - w_hi < 4.5, f'expected recessed bayonet cap < 4.5 mm proud, got {cap_hi - w_hi:.2f} mm'
            return dict(root=body, parts=[body, w], joints=[res])

        run_recipe(tmp, 'bayonet_axle', build_bayonet_axle, expect_badge='wheel-and-axle')

        def build_multi_wheel_bayonet():
            body = K.box2('Body', (-50, -24, 10), (50, 24, 36))
            wheels = []
            joints = []
            for label, x, y, ax, rec_opt in [
                ('FrontLeftWheel', 30, 24, '+Y', True),
                ('FrontRightWheel', 30, -24, '-Y', True),
                ('RearLeftWheel', -30, 24, '+Y', False),
                ('RearRightWheel', -30, -24, '-Y', False),
            ]:
                w = K.wheel(label, (x, y, 20), ax, diameter=32, width=10, tread=0)
                wheels.append(w)
                res = K.bayonet_axle(body, w, (x, y, 20), ax, width=10, recess=rec_opt, control=label)
                joints.append(res)
                # Recessed caps stick out < 4.5 mm; non-recessed caps sit outside the outer wheel face (> 7 mm).
                w_lo, w_hi = K.bounds(w)
                c_lo, c_hi = K.bounds(res.cap)
                proud = (c_hi.y - w_hi.y) if ax == '+Y' else (w_lo.y - c_lo.y)
                if rec_opt:
                    assert proud < 4.5, f'{label}: recessed cap protruded {proud:.2f} mm'
                else:
                    assert proud > 7.0, f'{label}: non-recessed cap protruded only {proud:.2f} mm'
            return dict(root=body, parts=[body, *wheels], joints=joints)

        run_recipe(tmp, 'multi_wheel_bayonet', build_multi_wheel_bayonet, expect_badge='wheel-and-axle', expect_badge_count=4)

        def build_snap_axle():
            body = K.box('Body', (60, 40, 24), (0, 0, 12))
            w = K.wheel('Wheel', (30, 0, 12), '+X', diameter=28, width=10, tread=12)
            res = K.snap_axle(body, w, (30, 0, 12), '+X', width=10, control='Wheel')
            return dict(root=body, parts=[body, w], joints=[res])

        run_recipe(tmp, 'snap_axle', build_snap_axle, expect_badge='wheel-and-axle')

        def build_through_axle():
            body = K.box('Body', (36, 40, 26), (0, 0, 13))
            res = K.through_axle(body, 'FrontAxle', (0, 0, 13), 'X', body_width=36, wheel_diameter=30, wheel_width=8, tread=12, control='Front')
            return dict(root=body, parts=[body], joints=[res])

        run_recipe(tmp, 'through_axle', build_through_axle, expect_badge='wheel-and-axle')

        def build_tyre():
            hub = K.cylinder('Hub', 15, 14, (0, 0, 7))
            res = K.tyre(hub, 'Tyre', (0, 0, 7), '+Z', hub_diameter=30, width=14)
            return dict(root=hub, parts=[hub], joints=[res])

        run_recipe(tmp, 'tyre', build_tyre)

        # ---------------- HINGES ----------------
        def build_pin_hinge():
            body = K.box2('Body', (-25, -20, 0), (0, 20, 36))
            door = K.box2('Door', (5.5, 8.5, 10.5), (9.5, 36.0, 25.5))
            res = K.pin_hinge(body, door, (7.5, 0, 18), '+Z', '-X', '+Y', length=32, limits=(-110, 0), control='Door')
            return dict(root=body, parts=[body, door], joints=[res])

        run_recipe(tmp, 'pin_hinge', build_pin_hinge, expect_badge='barrel-hinge')

        def build_snap_hinge():
            body = K.box2('Body', (-25, -20, 0), (0, 20, 34))
            door = K.box2('Door', (13.0, -1.5, 6.5), (38.0, 1.5, 27.5))
            res = K.snap_hinge(body, door, (6.5, 0, 17), '+Z', '-X', '+X', length=24, limits=(-70, 70), control='Door')
            return dict(root=body, parts=[body, door], joints=[res])

        run_recipe(tmp, 'snap_hinge', build_snap_hinge)

        def build_ball_socket():
            base = K.box2('Base', (-16, -16, -16), (16, 16, -2))
            head = K.box2('Head', (-10, -10, 14), (10, 10, 24))
            res = K.ball_socket(base, head, (0, 0, 0), '+Z', ball_diameter=14, stem_length=16, limits=(-20, 20), control='Head')
            return dict(root=base, parts=[base, head], joints=[res])

        run_recipe(tmp, 'ball_socket', build_ball_socket)

        def build_turntable():
            base = K.box('Base', (50, 50, 10), (0, 0, 5))
            platter = K.turntable_plate('Platter', (0, 0, 10), '+Z', diameter=42, thickness=5)
            res = K.turntable(base, platter, (0, 0, 10), '+Z', thickness=5, control='Turntable')
            return dict(root=base, parts=[base, platter], joints=[res])

        run_recipe(tmp, 'turntable', build_turntable)

        def build_bearing():
            housing = K.box('Housing', (40, 40, 8), (0, 0, 0))
            rotor = K.box('Rotor', (24, 24, 6), (0, 0, 12.5))
            res = K.bearing(housing, rotor, (0, 0, 0), '+Z', hub_diameter=12, housing_thickness=8, control='Rotor')
            return dict(root=housing, parts=[housing, rotor], joints=[res])

        run_recipe(tmp, 'bearing', build_bearing)

        # ---------------- SLIDERS ----------------
        def build_dovetail_slide():
            rail = K.box2('Rail', (-34, -18, -16), (38, 18, 0))
            carriage = K.box2('Carriage', (-10, -14, 0), (10, 14, 10))
            res = K.dovetail_slide(rail, carriage, (0, 0, 0), '+X', '+Z', travel=24, control='Slide')
            return dict(root=rail, parts=[rail, carriage], joints=[res])

        run_recipe(tmp, 'dovetail_slide', build_dovetail_slide, expect_badge='dovetail-slide')

        def build_tslot_rail():
            rail = K.box2('Rail', (-34, -18, -16), (38, 18, 0))
            slider = K.box2('Slider', (-10, -14, 0), (10, 14, 10))
            res = K.tslot_rail(rail, slider, (0, 0, 0), '+X', '+Z', travel=24, control='Slide')
            return dict(root=rail, parts=[rail, slider], joints=[res])

        run_recipe(tmp, 'tslot_rail', build_tslot_rail)

        def build_telescoping_tube():
            outer = K.box2('Outer', (-24, -24, -46), (24, 24, 0))
            inner = K.cylinder('Inner', 7.0, 56.0, (0, 0, 1.0))
            res = K.telescoping_tube(outer, inner, (0, 0, 0), '+Z', tube_diameter=14, travel=20, control='Extend')
            return dict(root=outer, parts=[outer, inner], joints=[res])

        run_recipe(tmp, 'telescoping_tube', build_telescoping_tube)

        def build_pin_slot():
            plate = K.box2('Plate', (-32, -16, -5), (32, 16, 0))
            block = K.box2('Block', (-12, -12, 0), (12, 12, 10))
            res = K.pin_slot(plate, block, (0, 0, 0), '+X', '+Z', travel=24, control='Slide')
            return dict(root=plate, parts=[plate, block], joints=[res])

        run_recipe(tmp, 'pin_slot', build_pin_slot)

        # ---------------- FASTENERS ----------------
        def build_snap_hook():
            wall = K.box2('Wall', (-20, -20, 0), (20, 20, 3))
            clip = K.box2('Clip', (-14, -14, -15), (14, 14, -9))
            res = K.snap_hook(wall, clip, (0, 0, 0), '+Z', '+X')
            return dict(root=wall, parts=[wall, clip], joints=[res])

        run_recipe(tmp, 'snap_hook', build_snap_hook)

        def build_snap_lid():
            jar = K.cylinder('Jar', 16, 20, (0, 0, -10))
            K.cut(jar, K.cylinder('_inside', 13, 20, (0, 0, -8)))
            lid = K.cylinder('Lid', 19.5, 3, (0, 0, 1.85))
            res = K.snap_lid(jar, lid, (0, 0, 0), '+Z', radius=16)
            return dict(root=jar, parts=[jar, lid], joints=[res])

        run_recipe(tmp, 'snap_lid', build_snap_lid)

        def build_bayonet_lock():
            socket = K.box2('Socket', (-22, -22, -20), (22, 22, 0))
            cap = K.cylinder('Cap', 18, 4, (0, 0, 2.4))
            res = K.bayonet_lock(socket, cap, (0, 0, 0), '+Z')
            return dict(root=socket, parts=[socket, cap], joints=[res])

        run_recipe(tmp, 'bayonet_lock', build_bayonet_lock)

        def build_bolt_nut():
            base = K.box2('Base', (-16, -16, -6), (16, 16, 0))
            nut = K.cylinder('Nut', 11, 10, (0, 0, 7.0))
            res = K.bolt_nut(base, nut, (0, 0, 0), '+Z', diameter=12, pitch=2.5, length=16, seat=2.0)
            return dict(root=base, parts=[base, nut], joints=[res])

        run_recipe(tmp, 'bolt_nut', build_bolt_nut)

        def build_tab_slot():
            plate = K.box2('Plate', (-28, -14, -4), (28, 14, 0))
            wall = K.box2('Wall', (-24, -4, 0.35), (24, 4, 16))
            res = K.tab_slot(plate, wall, (0, 0, 0), '+Z', '+X')
            return dict(root=plate, parts=[plate, wall], joints=[res])

        run_recipe(tmp, 'tab_slot', build_tab_slot)

        def build_press_pegs():
            a = K.box2('PartA', (-20, -12, -12), (20, 12, 0))
            b = K.box2('PartB', (-19, -11, 0.3), (19, 11, 14))
            res = K.press_pegs(a, b, [(-10, 0, 0), (10, 0, 0)], '+Z')
            return dict(root=a, parts=[a, b], joints=[res])

        run_recipe(tmp, 'press_pegs', build_press_pegs, expect_bullet='friction')

        def build_dogbone_key():
            a = K.box2('PlateA', (-24, -14, -10), (-0.2, 14, 0))
            b = K.box2('PlateB', (0.2, -14, -10), (24, 14, 0))
            res = K.dogbone_key(a, b, (0, 0, 0), '+X', '+Z')
            return dict(root=a, parts=[a, b], joints=[res])

        run_recipe(tmp, 'dogbone_key', build_dogbone_key, expect_bullet='friction')

        def build_magnet_pockets():
            a = K.box2('MagA', (-20, -14, -10), (20, 14, 0))
            b = K.box2('MagB', (-19, -13, 0.3), (19, 13, 10))
            res = K.magnet_pockets(a, b, [(-8, 0, 0), (8, 0, 0)], '+Z', pins=[(0, 8, 0), (0, -8, 0)])
            return dict(root=a, parts=[a, b], joints=[res])

        run_recipe(tmp, 'magnet_pockets', build_magnet_pockets, expect_bullet='friction')

        def build_insert_boss():
            a = K.box2('BossA', (-16, -12, -12), (16, 12, 0))
            b = K.box2('BossB', (-15, -11, 0.3), (15, 11, 8))
            res = K.insert_boss(a, b, [(-8, 0, 0), (8, 0, 0)], '+Z', screw='M3')
            return dict(root=a, parts=[a, b], joints=[res])

        run_recipe(tmp, 'insert_boss', build_insert_boss, expect_bullet='friction')

        # ---------------- MECHANISMS ----------------
        def build_gear_pair():
            base = K.box2('Base', (-24, -24, -6), (56, 24, 0))
            res = K.gear_pair(base, (0, 0, 0), '+Z', 16, 16, toward='+X', controls=('GearA', 'GearB'))
            return dict(root=base, parts=[base], joints=[res])

        run_recipe(tmp, 'gear_pair', build_gear_pair, expect_badge='gear-pair')

        def build_rack_pinion():
            base = K.box2('Base', (-56, -42, -6), (56, 24, 0))
            res = K.rack_pinion(base, (0, 0, 0), '+Z', '+X', pinion_teeth=16, travel=24, controls=('Pinion', 'Rack'))
            return dict(root=base, parts=[base], joints=[res])

        run_recipe(tmp, 'rack_pinion', build_rack_pinion, expect_badge='rack-and-pinion')

        def build_ratchet():
            # Ratchet axis horizontal (+Y), pawl side +Z so gravity drops pawl nose into teeth.
            base = K.box2('Base', (-34, -8, -32), (34, 0, 38))
            res = K.ratchet(base, (0, 0, 0), '+Y', '+Z', controls=('Wheel', 'Pawl'))
            return dict(root=base, parts=[base], joints=[res])

        run_recipe(tmp, 'ratchet', build_ratchet)

        def build_cam_follower():
            base = K.box2('Base', (-28, -32, -6), (56, 32, 0))
            res = K.cam_follower(base, (0, 0, 0), '+Z', '+X', controls=('Cam', 'Follower'))
            return dict(root=base, parts=[base], joints=[res])

        run_recipe(tmp, 'cam_follower', build_cam_follower)

        def build_detent_slider():
            base = K.box2('Base', (-48, -16, -6), (56, 24, 0))
            res = K.detent_slider(base, (0, 0, 0), '+Z', '+X', control='Detent')
            return dict(root=base, parts=[base], joints=[res])

        run_recipe(tmp, 'detent_slider', build_detent_slider)

        def build_flexure_spring():
            s = K.flexure_spring('Spring', (0, 0, 0))
            return dict(root=s, parts=[s], joints=[])

        run_recipe(tmp, 'flexure_spring', build_flexure_spring, expect_bullet='skip')

        def build_living_hinge():
            h = K.living_hinge('Hinge', (0, 0, 0), '+Z', across='+X')
            return dict(root=h, parts=[h], joints=[])

        run_recipe(tmp, 'living_hinge', build_living_hinge, expect_bullet='skip', expect_badge='living-hinge')

        # ---------------- NEGATIVE CASES ----------------
        if want('negative_cases'):
            test_negative_cases(tmp)

    print('CAD_JOINTS_KIT_ALL_OK')


if __name__ == '__main__':
    main()
