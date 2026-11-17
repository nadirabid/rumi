"""Compare actual preview triangles against their saved baseline using Blender's BVH.

Triangle identities and adjacency come from the baseline and stay fixed across cases.
Existing intersecting pairs are reported, never used to excuse a new pair nearby.
"""
import json
from pathlib import Path
import sys
from mathutils.bvhtree import BVHTree


def intersections(points, triangles, topology):
    """Return nonadjacent intersecting triangle pairs with stable source identities."""
    tree = BVHTree.FromPolygons(points, triangles, all_triangles=True, epsilon=0)
    return {(a, b) for a, b in tree.overlap(tree)
            if a < b and not topology[a].intersection(topology[b])}


def check(request):
    """Check every requested endpoint without writing model geometry."""
    base = json.loads(Path(request['baseline']).read_text())
    triangles = base['triangles']
    # USD expands shared triangle vertices; weld only within each source part.
    keys = [(part, *(round(v, 5) for v in point)) for part, point in zip(base['parts'], base['points'])]
    topology = [set(keys[v] for v in triangle) for triangle in triangles]
    baseline = intersections(base['points'], triangles, topology)
    results = []
    for case in request['cases']:
        points = json.loads(Path(case['path']).read_text())
        current = intersections(points, triangles, topology)
        added = sorted(current - baseline)
        results.append(dict(id=case['id'], baselineIntersectionPairs=len(baseline),
                            intersectionPairs=len(current), newIntersectionPairs=len(added),
                            examples=[dict(triangles=[a, b], location=points[triangles[a][0]]) for a, b in added[:5]]))
    return dict(version=1, cases=results)


if __name__ == '__main__':
    request = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
    Path(request['output']).write_text(json.dumps(check(request)))
