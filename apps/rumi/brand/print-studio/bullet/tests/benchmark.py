"""Compare complete native checks, ordered findings and peak RSS on macOS fixtures."""
import argparse
import copy
import json
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from fixtures import wheel, two_wheels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reference', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('--rounds', type=int, default=3)
args = parser.parse_args()
if sys.platform != 'darwin' or args.rounds < 1:
    parser.error('Run on macOS with at least one round')

for name, make in [('wheel', wheel), ('two_wheels', two_wheels)]:
    request = make()
    if name == 'wheel':
        request['settings'].update(gravityMps2=[0, 0, -9.81], friction=.2, movementSampleDegrees=15)
    expected = None
    for label, executable, workers in [('reference', args.reference, 1), ('serial', args.candidate, 1), ('parallel', args.candidate, 2)]:
        request['settings']['retentionWorkers'] = workers
        durations, peaks = [], []
        for _ in range(args.rounds):
            started = time.perf_counter()
            process = subprocess.run(['/usr/bin/time', '-l', str(executable.resolve())], input=json.dumps(request),
                                     text=True, capture_output=True, timeout=300, check=True)
            durations.append(time.perf_counter() - started)
            peaks.append(int(re.search(r'(\d+)\s+maximum resident set size', process.stderr)[1]))
            result = json.loads(process.stdout)
            normalized = copy.deepcopy(result)
            normalized.pop('elapsedMs')
            for key in ['maxTotalSteps', 'retentionWorkers']:
                normalized['policy'].pop(key, None)
            if expected is None:
                expected = normalized
            if normalized != expected:
                raise AssertionError(f'{name}/{label}: findings or coverage changed')
        print(json.dumps(dict(case=name, mode=label, medianSeconds=statistics.median(durations),
                              samplesSeconds=durations, peakRssBytes=max(peaks), status=result['status'],
                              complete=result['coverage']['complete'])), flush=True)
