"""Check closed-outline distances and benchmark synthetic rim selection in bundled Blender.

Run with Blender --background --factory-startup --python-exit-code 1 --python this_file.
Add -- --benchmark for three threshold-free samples, excluding Blender startup and fixture setup.
"""
import json
import math
import runpy
import sys
import time
from pathlib import Path

import numpy as np

kit = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'blender/rumi_joints.py'))
distances = kit['outline_distances']


def reference(points, outlines):
    """Return scalar point-to-segment distances for an independent numerical comparison."""
    result = []
    for x, y in points:
        best = math.inf
        for outline in outlines:
            for i, (ax, ay) in enumerate(outline):
                bx, by = outline[(i + 1) % len(outline)]
                vx, vy = bx - ax, by - ay
                length = vx * vx + vy * vy
                fraction = max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / length)) if length else 0
                best = min(best, (x - (ax + fraction * vx)) ** 2 + (y - (ay + fraction * vy)) ** 2)
        result.append(math.sqrt(best))
    return result


outline = [(0, 0), (2, 0), (2, 2), (0, 2), (0, 2)]
points = [(1, 1), (-1, 1), (2, 1), (3, 3), (0, 0)]
for batch in (1, 3, 256):
    np.testing.assert_allclose(distances(points, [outline], batch), [1, 1, 0, math.sqrt(2), 0])
np.testing.assert_allclose(distances([(2, 0)], [[(0, 0)]]), [2])
np.testing.assert_allclose(distances([(0.5e-8, 1)], [[(0, 0), (1e-8, 0)]]), [1])
assert distances([], [outline]).size == 0
for points_arg, outlines_arg in [([(math.nan, 0)], [outline]), ([(0, 0)], []),
                                 ([(0, 0)], [[]]), ([(0, 0, 0)], [outline]), ([[], []], [outline])]:
    try:
        distances(points_arg, outlines_arg)
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid coordinates were accepted')
for batch in (0, -1, True, 1.5):
    try:
        distances(points, [outline], batch)
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid batch size was accepted')

points = [(80 * math.cos(i * .617), 100 * math.sin(i * .319)) for i in range(5000)]
outlines = [[(70 * math.cos(i * math.tau / 480), 90 * math.sin(i * math.tau / 480)) for i in range(480)],
            [(0, 0), (1, 0), (1, 1)]]
expected = reference(points, outlines)
actual = distances(points, outlines)
np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=1e-12)
np.testing.assert_array_equal(actual < 2.6, np.asarray(expected) < 2.6)
print('OUTLINE_DISTANCES_OK')
if '--benchmark' in sys.argv:
    samples = []
    for _ in range(3):
        start = time.perf_counter()
        expected = reference(points, outlines)
        scalar_seconds = time.perf_counter() - start
        start = time.perf_counter()
        actual = distances(points, outlines)
        vector_seconds = time.perf_counter() - start
        np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=1e-12)
        samples.append(dict(scalarSeconds=scalar_seconds, vectorSeconds=vector_seconds,
                            speedup=scalar_seconds / vector_seconds))
    print(json.dumps(dict(points=len(points), segments=sum(map(len, outlines)), samples=samples)))
