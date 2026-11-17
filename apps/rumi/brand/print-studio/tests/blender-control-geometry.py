"""Regression for stable pair identities, source defects, and expanded adjacency.

Run bundled Blender --background --python this_file.
"""
import json
from pathlib import Path
import runpy
import tempfile

checker = runpy.run_path(str(Path(__file__).parent.parent / 'blender/control-geometry.py'))
points = [(-2,-2,0),(2,-2,0),(0,2,0), (0,-1,-1),(0,-1,1),(0,1,0),
          (4,-1,-1),(4,-1,1),(4,1,0)]
triangles = [(0,1,2),(3,4,5),(6,7,8)]
with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    baseline = folder/'baseline.json'
    baseline.write_text(json.dumps(dict(points=points, parts=[0]*9, triangles=triangles)))
    changed = points[:3] + [(x+4,y,z) for x,y,z in points[3:6]] + [(x-4,y,z) for x,y,z in points[6:]]
    path = folder/'changed.json'; path.write_text(json.dumps(changed))
    same = folder/'same.json'; same.write_text(json.dumps(points))
    result = checker['check'](dict(baseline=str(baseline), cases=[dict(id='same',path=str(same)),dict(id='replace',path=str(path))]))
    assert result['cases'][0]['newIntersectionPairs'] == 0, result
    assert result['cases'][1]['baselineIntersectionPairs'] == result['cases'][1]['intersectionPairs'] == 1, result
    assert result['cases'][1]['newIntersectionPairs'] == 1, result
    assert result['cases'][1]['examples'][0]['triangles'] == [0,2], result
    baseline.write_text(json.dumps(dict(points=points, parts=[0]*3+[1]*6, triangles=triangles)))
    assert checker['check'](dict(baseline=str(baseline),cases=[dict(id='cross-part',path=str(path))]))['cases'][0]['newIntersectionPairs'] == 1
print('CONTROL_GEOMETRY_OK')
