"""Verify pure-NumPy triangle-triangle intersection checks match control-geometry contract."""
from __future__ import annotations

import json
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'cad/control_geometry.py'
checker = runpy.run_path(str(SCRIPT))

points = [
    (-2, -2, 0), (2, -2, 0), (0, 2, 0),
    (0, -1, -1), (0, -1, 1), (0, 1, 0),
    (4, -1, -1), (4, -1, 1), (4, 1, 0),
]
triangles = [(0, 1, 2), (3, 4, 5), (6, 7, 8)]

with tempfile.TemporaryDirectory(prefix='rumi-ctrl-geom-') as folder_str:
    folder = Path(folder_str)
    baseline = folder / 'baseline.json'
    baseline.write_text(json.dumps({'points': points, 'parts': [0] * 9, 'triangles': triangles}))
    changed = points[:3] + [(x + 4, y, z) for x, y, z in points[3:6]] + [(x - 4, y, z) for x, y, z in points[6:]]
    changed_path = folder / 'changed.json'
    changed_path.write_text(json.dumps(changed))
    same_path = folder / 'same.json'
    same_path.write_text(json.dumps(points))

    result = checker['check']({
        'baseline': str(baseline),
        'cases': [
            {'id': 'same', 'path': str(same_path)},
            {'id': 'replace', 'path': str(changed_path)},
        ],
    })
    assert result['version'] == 1, result
    assert result['cases'][0]['newIntersectionPairs'] == 0, result
    assert result['cases'][1]['baselineIntersectionPairs'] == result['cases'][1]['intersectionPairs'] == 1, result
    assert result['cases'][1]['newIntersectionPairs'] == 1, result
    assert result['cases'][1]['examples'][0]['triangles'] == [0, 2], result

    # Cross-part boundary: identical coordinates in different parts are NOT adjacent
    baseline.write_text(json.dumps({'points': points, 'parts': [0] * 3 + [1] * 6, 'triangles': triangles}))
    cross = checker['check']({'baseline': str(baseline), 'cases': [{'id': 'cross-part', 'path': str(changed_path)}]})
    assert cross['cases'][0]['newIntersectionPairs'] == 1, cross

    # Coplanar overlapping triangles must also be detected
    cop_pts = [
        (0, 0, 0), (4, 0, 0), (0, 4, 0),
        (1, 1, 0), (5, 1, 0), (1, 5, 0),
    ]
    cop_base = folder / 'cop.json'
    cop_base.write_text(json.dumps({'points': cop_pts, 'parts': [0, 0, 0, 1, 1, 1], 'triangles': [(0, 1, 2), (3, 4, 5)]}))
    cop_same = folder / 'cop-same.json'
    cop_same.write_text(json.dumps(cop_pts))
    cop_res = checker['check']({'baseline': str(cop_base), 'cases': [{'id': 'cop', 'path': str(cop_same)}]})
    assert cop_res['cases'][0]['baselineIntersectionPairs'] == 1, cop_res

    # CLI works with both `script request.json` and `script -- request.json`
    for args_prefix in ([], ['--']):
        out_path = folder / f'out-{len(args_prefix)}.json'
        req_path = folder / f'req-{len(args_prefix)}.json'
        req_path.write_text(json.dumps({
            'baseline': str(baseline),
            'cases': [{'id': 'cli', 'path': str(changed_path)}],
            'output': str(out_path),
        }))
        proc = subprocess.run([sys.executable, str(SCRIPT), *args_prefix, str(req_path)], check=True, capture_output=True, text=True)
        cli_out = json.loads(out_path.read_text())
        assert cli_out['version'] == 1 and cli_out['cases'][0]['newIntersectionPairs'] == 1, cli_out

print('CAD_CONTROL_GEOMETRY_OK')
