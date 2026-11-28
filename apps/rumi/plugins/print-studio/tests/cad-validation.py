"""Verify CAD validation on USD/STL snapshots, exact B-Rep clearances, and per-part print orientation."""
from __future__ import annotations

import json
import math
import runpy
import struct
import tempfile
from pathlib import Path

import build123d as bd
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CAD = runpy.run_path(str(ROOT / 'cad/rumi_cad.py'))
USD = runpy.run_path(str(ROOT / 'cad/robot_usd.py'))
VAL = runpy.run_path(str(ROOT / 'cad/validate.py'))

SETTINGS = {
    'minimumThicknessMm': 1.0,
    'degenerateThreshold': 1e-6,
    'overhangDegrees': 45.0,
    'sharpDegrees': 160.0,
    'distortionDegrees': 45.0,
    'minimumClearanceMm': 0.2,
}
IDENTITY_TRANSFORM = {
    'scale': 1.0,
    'rotate': {'x': 0.0, 'y': 0.0, 'z': 0.0},
    'position': {'x': 0.0, 'y': 0.0, 'z': 0.0},
}


def write_binary_stl(path: Path, pts: np.ndarray, tris: np.ndarray) -> None:
    """Write a binary STL from mm vertices and triangle indices."""
    header = b'rumi-test-stl'.ljust(80, b'\x00')
    chunks = [header, struct.pack('<I', len(tris))]
    for i0, i1, i2 in tris:
        p0, p1, p2 = pts[i0], pts[i1], pts[i2]
        n = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(n)
        n = n / ln if ln > 1e-12 else np.array([0.0, 0.0, 1.0])
        chunks.append(struct.pack(
            '<12fH',
            float(n[0]), float(n[1]), float(n[2]),
            float(p0[0]), float(p0[1]), float(p0[2]),
            float(p1[0]), float(p1[1]), float(p1[2]),
            float(p2[0]), float(p2[1]), float(p2[2]),
            0,
        ))
    path.write_bytes(b''.join(chunks))


with tempfile.TemporaryDirectory(prefix='rumi-cad-val-') as tmp:
    work = Path(tmp)

    # 1. Legacy Blender robot.usda fixture parses identically with zero pxr.
    fixture = ROOT / 'tests/fixtures/robot.usda'
    parsed = USD['read_robot'](fixture)
    conn = parsed['assembly']['connections'][0]
    assert conn['id'] == 'DoorHinge' and conn['kind'] == 'revolute', conn
    assert conn['parent'] == 'Body' and conn['child'] == 'Door', conn
    assert conn['range'] == [0.0, 90.0] and conn['control'] == 'Door', conn
    assert all(abs(a - b) < 1e-4 for a, b in zip(conn['pivot'], (15.0, 0.0, 0.0))), conn
    assert all(abs(a - b) < 1e-4 for a, b in zip(conn['axis'], (0.0, 0.0, 1.0))), conn

    # Separate-printing policy rejects print-in-place moving fixture in assembly stage.
    pip_usd = work / 'legacy-pip.usda'
    pip_usd.write_text(fixture.read_text().replace(
        'rumi:manufacturingMode = "separate"', 'rumi:manufacturingMode = "print-in-place"'
    ))
    rep_pip = VAL['validate']({'input': str(pip_usd), 'stage': 'assembly'})
    assert rep_pip['status'] == 'needs_repair', rep_pip
    assert rep_pip['checks'][0]['code'] == 'separate_printing_required', rep_pip

    # 2. Closed vs open STL checks
    cube = bd.Box(10, 10, 10)
    pts, tris = CAD['tessellate_shape'](cube)
    closed_stl = work / 'closed.stl'
    write_binary_stl(closed_stl, pts, tris)
    rep_closed = VAL['validate']({
        'input': str(closed_stl),
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
        'mechanicsOutput': str(work / 'closed-mech.json'),
        'assembly': {
            'version': 1, 'root': 'model', 'parts': [{'id': 'model', 'mesh': 'model'}],
            'connections': [], 'manufacturing': {'mode': 'print-in-place'},
        },
    })
    assert rep_closed['status'] in ('passed', 'review') and rep_closed['printReady'] is False, rep_closed
    assert not any(c['count'] for c in rep_closed['checks'] if c['severity'] == 'error'), rep_closed
    assert all(abs(rep_closed['dimensions'][a] - 10.0) < 1e-3 for a in 'xyz'), rep_closed
    mech = json.loads((work / 'closed-mech.json').read_text())
    assert abs(min(p[2] for p in mech['bodies'][0]['vertices'])) < 1e-3

    # Remove 1 face -> open mesh -> non_manifold_edges error
    open_stl = work / 'open.stl'
    write_binary_stl(open_stl, pts, tris[1:])
    rep_open = VAL['validate']({
        'input': str(open_stl),
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert rep_open['status'] == 'needs_repair', rep_open
    assert next(c for c in rep_open['checks'] if c['code'] == 'non_manifold_edges')['count'] > 0, rep_open

    # 3. Exact B-Rep curved bore clearance (shaft inside cylindrical bore)
    def bore_shaft_clearance(radial_gap_mm: float):
        housing = bd.Box(24, 24, 12) - bd.Cylinder(5.0 + radial_gap_mm, 14)
        housing.label = 'Housing'
        shaft = bd.Cylinder(5.0, 12)
        shaft.label = 'Shaft'
        model_dir = work / f'bore-{radial_gap_mm}'
        asm = {
            'version': 1,
            'root': 'Housing',
            'parts': [{'id': 'Housing', 'mesh': 'Housing'}, {'id': 'Shaft', 'mesh': 'Shaft'}],
            'connections': [{
                'id': 'Spin', 'kind': 'revolute', 'parent': 'Housing', 'child': 'Shaft',
                'axis': [0, 0, 1], 'pivot': [0, 0, 0], 'range': [-180, 180],
            }],
            'sequences': [],
            'manufacturing': {
                'mode': 'separate',
                'steps': [{'part': 'Shaft', 'actions': [{'kind': 'translate', 'delta': [0, 0, 20]}]}],
            },
        }
        pub = CAD['publish'](model_dir, [housing, shaft], assembly=asm, check=False)
        return VAL['validate']({
            'input': pub['revisionUsd'],
            'settings': SETTINGS,
            'transform': IDENTITY_TRANSFORM,
            'volume': None,
            'mechanicsOutput': str(work / f'bore-{radial_gap_mm}.json'),
        })

    tight = bore_shaft_clearance(0.12)
    clr = next(c for c in tight['checks'] if c['code'] == 'insufficient_clearance')
    assert clr['severity'] == 'error' and clr['count'] == 1, clr
    assert abs(clr['details']['pairs'][0]['gapMm'] - 0.12) < 0.005, clr

    good = bore_shaft_clearance(0.35)
    clr_good = next(c for c in good['checks'] if c['code'] == 'insufficient_clearance')
    assert clr_good['count'] == 0, clr_good
    assert not any(c['count'] for c in good['checks'] if c['severity'] == 'error'), good

    # 4. Fixed mate: flush contact passes, overlapping solids fail
    a = bd.Box(10, 10, 10)
    a.label = 'Base'
    b_flush = bd.Pos(10, 0, 0) * bd.Box(10, 10, 10)
    b_flush.label = 'Cap'
    asm_fixed = {
        'version': 1, 'root': 'Base',
        'parts': [{'id': 'Base', 'mesh': 'Base'}, {'id': 'Cap', 'mesh': 'Cap'}],
        'connections': [{
            'id': 'CapLock', 'kind': 'fixed', 'parent': 'Base', 'child': 'Cap',
            'retainer': 'bayonet', 'axis': [1, 0, 0], 'pivot': [5, 0, 0],
        }],
        'sequences': [],
        'manufacturing': {
            'mode': 'separate',
            'steps': [{
                'part': 'Cap',
                'actions': [
                    {'kind': 'rotate', 'pivot': [5, 0, 0], 'axis': [1, 0, 0], 'degrees': 90, 'pitchMm': 0},
                    {'kind': 'translate', 'delta': [20, 0, 0]},
                ],
            }],
        },
    }
    pub_flush = CAD['publish'](work / 'fixed-flush', [a, b_flush], assembly=asm_fixed, check=False)
    rep_flush = VAL['validate']({
        'input': pub_flush['revisionUsd'],
        'settings': SETTINGS,
        'transform': {'scale': 2.0, 'rotate': {'x': 0.0, 'y': 0.0, 'z': 90.0}, 'position': {'x': 10.0, 'y': 20.0, 'z': 0.0}},
        'volume': None,
        'mechanicsOutput': str(work / 'fixed-flush-mech.json'),
    })
    assert rep_flush['status'] != 'needs_repair', rep_flush
    assert next(c for c in rep_flush['checks'] if c['code'] == 'intersecting_faces')['count'] == 0, rep_flush
    assert next(c for c in rep_flush['checks'] if c['code'] == 'insufficient_clearance')['count'] == 0, rep_flush
    # Also verify flush fixed mate passes on mesh-only USDA snapshot (no companion parts/*.brep)
    mesh_only_flush = work / 'fixed-flush-snapshot.usda'
    mesh_only_flush.write_bytes(Path(pub_flush['revisionUsd']).read_bytes())
    rep_flush_mesh = VAL['validate']({
        'input': str(mesh_only_flush),
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert rep_flush_mesh['status'] != 'needs_repair', rep_flush_mesh
    assert next(c for c in rep_flush_mesh['checks'] if c['code'] == 'intersecting_faces')['count'] == 0, rep_flush_mesh
    # Verify placement transform propagated to retainer axis and rotate/translate actions
    mech_flush = json.loads((work / 'fixed-flush-mech.json').read_text())
    fc = mech_flush['assembly']['connections'][0]
    assert fc['retainer'] == 'bayonet'
    assert abs(fc['axis'][1] - 1.0) < 1e-5, fc  # +X rotated 90 deg around +Z -> +Y
    rot_act, trans_act = mech_flush['assembly']['manufacturing']['steps'][0]['actions']
    assert abs(rot_act['axis'][1] - 1.0) < 1e-5, rot_act
    assert abs(trans_act['delta'][1] - 40.0) < 1e-4, trans_act  # 20mm * scale 2 rotated +90 deg -> +40 Y

    b_overlap = bd.Pos(8, 0, 0) * bd.Box(10, 10, 10)
    b_overlap.label = 'Cap'
    pub_ov = CAD['publish'](work / 'fixed-overlap', [a, b_overlap], assembly=asm_fixed, check=False)
    rep_ov = VAL['validate']({
        'input': pub_ov['revisionUsd'],
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
        'mechanicsOutput': str(work / 'fixed-ov-mech.json'),
    })
    assert next(c for c in rep_ov['checks'] if c['code'] == 'insufficient_clearance')['count'] == 1, rep_ov
    assert next(c for c in rep_ov['checks'] if c['code'] == 'intersecting_faces')['count'] > 0, rep_ov

    # 5. Per-part print-orientation analysis: an upside-down T-bracket has huge overhangs in assembled
    #    pose, but ZERO overhangs when flipped onto its wide top flange!
    flange = bd.Pos(0, 0, 15) * bd.Box(30, 30, 4)
    stem = bd.Pos(0, 0, 6.5) * bd.Box(6, 6, 13)
    upside_down_t = flange + stem
    upside_down_t.label = 'Bracket'
    pub_t = CAD['publish'](work / 'print-orient', [upside_down_t], check=False)
    rep_t = VAL['validate']({
        'input': pub_t['revisionUsd'],
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    ovh = next(c for c in rep_t['checks'] if c['code'] == 'overhangs')
    assert ovh['count'] == 0, (ovh, rep_t.get('printOrientations'))
    orient = rep_t['printOrientations']['Bracket']
    assert orient['bedContactAreaMm2'] > 850.0, orient  # 30x30 = 900 mm^2 flange on bed!
    assert orient['downNormal'][2] > 0.99, orient  # original +Z face flips down onto bed!

    # Sphere has tiny bed contact -> small_bed_contact warning
    ball = bd.Sphere(10)
    ball.label = 'Ball'
    pub_ball = CAD['publish'](work / 'ball-contact', [ball], check=False)
    rep_ball = VAL['validate']({
        'input': pub_ball['revisionUsd'],
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert any(c['code'] == 'small_bed_contact' and c['count'] == 1 for c in rep_ball['checks']), rep_ball

    # 6. Valid closed B-Rep with tangent cylindrical-to-planar seam must NOT false-fail non_manifold_edges,
    #    while an open B-Rep shell (missing face) and a mesh-only snapshot still strictly fail!
    deck = bd.Box(20, 20, 10)
    boss = bd.Pos(0, 0, 7.5) * bd.Rot(0, 90, 0) * bd.Cylinder(2.5, 6)  # tangent to z = 5.0 deck
    tangent_solid = deck + boss
    tangent_solid.label = 'TangentBody'
    raw_pts, raw_tris = CAD['tessellate_shape'](tangent_solid)
    assert VAL['_check_part_topology'](raw_pts, raw_tris, 1e-6, 160.0)['non_manifold_edges'] > 0
    pub_tan = CAD['publish'](work / 'tangent-seam', [tangent_solid], check=False)
    rep_tan = VAL['validate']({
        'input': pub_tan['revisionUsd'],
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert rep_tan['status'] != 'needs_repair', rep_tan
    assert next(c for c in rep_tan['checks'] if c['code'] == 'non_manifold_edges')['count'] == 0, rep_tan
    assert not any(c['code'] == 'invalid_brep_solid' for c in rep_tan['checks']), rep_tan

    # Mesh-only copy (no companion parts/*.brep) still strictly flags the raw mesh non-manifold edge
    tan_mesh_only = work / 'tangent-mesh-only.usda'
    tan_mesh_only.write_bytes(Path(pub_tan['revisionUsd']).read_bytes())
    rep_tan_mesh = VAL['validate']({
        'input': str(tan_mesh_only),
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert rep_tan_mesh['status'] == 'needs_repair', rep_tan_mesh
    assert next(c for c in rep_tan_mesh['checks'] if c['code'] == 'non_manifold_edges')['count'] > 0, rep_tan_mesh

    # Genuinely open B-Rep shell (box with one face removed) strictly fails BOTH non_manifold_edges and invalid_brep_solid
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    sew = BRepBuilderAPI_Sewing()
    for face in list(bd.Box(10, 10, 10).faces())[:-1]:
        sew.Add(face.wrapped)
    sew.Perform()
    open_brep = bd.Shape(sew.SewedShape())
    open_brep.label = 'OpenShell'
    pub_open_brep = CAD['publish'](work / 'open-brep', [open_brep], check=False)
    rep_open_brep = VAL['validate']({
        'input': pub_open_brep['revisionUsd'],
        'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM,
        'volume': None,
    })
    assert rep_open_brep['status'] == 'needs_repair', rep_open_brep
    assert next(c for c in rep_open_brep['checks'] if c['code'] == 'non_manifold_edges')['count'] > 0, rep_open_brep
    assert next(c for c in rep_open_brep['checks'] if c['code'] == 'invalid_brep_solid')['count'] == 1, rep_open_brep

    # 7. Generic 2D-layer printability pre-checks (no printer-specific slicer required):
    #    (a) Clean flat box -> zero layer printability warnings.
    clean_box = bd.Box(24, 24, 10)
    clean_box.label = 'CleanBox'
    pub_clean = CAD['publish'](work / 'layer-clean', [clean_box], check=False)
    rep_clean = VAL['validate']({
        'input': pub_clean['revisionUsd'], 'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM, 'volume': None,
    })
    for code in ('floating_islands', 'unprintable_thin_walls', 'tip_over_risk', 'trapped_overhangs'):
        assert not any(c['code'] == code for c in rep_clean['checks']), (code, rep_clean['checks'])

    #    (b) Sub-nozzle 0.28 mm thin fin on a solid base -> flags unprintable_thin_walls.
    base_plate = bd.Box(20, 20, 4)
    thin_fin = bd.Pos(0, 0, 7) * bd.Box(14, 0.28, 10)
    fin_part = base_plate + thin_fin
    fin_part.label = 'ThinFin'
    pub_fin = CAD['publish'](work / 'layer-thin', [fin_part], check=False)
    rep_fin = VAL['validate']({
        'input': pub_fin['revisionUsd'], 'settings': SETTINGS,
        'transform': IDENTITY_TRANSFORM, 'volume': None,
    })
    assert any(c['code'] == 'unprintable_thin_walls' and c['count'] == 1 for c in rep_fin['checks']), rep_fin['checks']

    #    (c) Part with downward-hanging arm (U-hook) -> flags floating_islands and trapped_overhangs.
    u_base = bd.Box(30, 30, 4)
    u_post = bd.Pos(-11, 0, 12) * bd.Box(8, 30, 20)
    u_arm = bd.Pos(2, 0, 20) * bd.Box(26, 30, 4)
    u_drop = bd.Pos(11, 0, 14) * bd.Box(8, 12, 10)  # hangs down into air above u_base
    u_part = u_base + u_post + u_arm + u_drop
    u_part.label = 'HangingArm'
    # Verify directly in upright orientation where u_drop starts mid-air above u_base
    u_pts, u_tris = CAD['tessellate_shape'](u_part)
    u_layer = VAL['_analyze_part_layer_printability'](u_pts, u_tris, 45.0)
    assert u_layer['floatingIslandCount'] >= 1, u_layer
    assert u_layer['trappedOverhangAreaMm2'] >= 20.0, u_layer

    #    (d) Off-center cantilevered block has COM outside its bed footprint -> flags tip_over_risk.
    foot = bd.Box(6, 6, 4)
    cantilever = bd.Pos(16, 0, 14) * bd.Box(34, 6, 16)
    tip_part = foot + cantilever
    tip_pts, tip_tris = CAD['tessellate_shape'](tip_part)
    tip_layer = VAL['_analyze_part_layer_printability'](tip_pts, tip_tris, 45.0)
    assert tip_layer['tipOverRisk'] is True and tip_layer['comInsideBed'] is False, tip_layer

print('CAD_VALIDATION_OK: USD/STL checks, exact B-Rep curved clearances, fixed mates, transforms, print orientations, and 2D-layer printability')
