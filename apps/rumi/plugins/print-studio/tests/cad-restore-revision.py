"""Verify exact revision restoration, retained history, and failure without replacing the preview."""
from __future__ import annotations

import contextlib
import io
import json
import runpy
import tempfile
from pathlib import Path
from unittest.mock import patch

import build123d as bd

ROOT = Path(__file__).resolve().parents[1]
CAD = runpy.run_path(str(ROOT / 'cad/rumi_cad.py'))

box1 = bd.Box(10, 12, 14)
box1.label = 'Body'
box2 = bd.Box(20, 12, 14)
box2.label = 'Body'

with tempfile.TemporaryDirectory(prefix='rumi-cad-restore-') as temporary:
    directory = Path(temporary)
    first = CAD['publish'](directory, [box1], check=False)
    first_usd = Path(first['revisionUsd'])
    first_bytes = first_usd.read_bytes()
    original_step = Path(first['step']).read_bytes()

    second = CAD['publish'](directory, [box2], check=False)
    second_bytes = Path(second['revisionUsd']).read_bytes()
    assert first_bytes != second_bytes

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        restored = CAD['restore_revision'](directory, first_usd.parent.name)
    assert (directory / 'model.usda').read_bytes() == first_bytes
    assert Path(second['revisionUsd']).read_bytes() == second_bytes
    assert first_usd.read_bytes() == first_bytes
    assert Path(restored['step']).read_bytes() == original_step
    assert restored['validation'] == 'pending' and restored['printReady'] is False
    assert json.loads(output.getvalue().removeprefix('RUMI_MODEL ')) == restored
    assert len(list((directory / 'revisions').iterdir())) == 2

    # Invalid revision names & path traversal rejected without touching preview
    for name in ('../outside', str(first_usd.parent), '.', '..', '', 'missing'):
        try:
            CAD['restore_revision'](directory, name)
        except ValueError:
            pass
        else:
            raise AssertionError(f'Invalid revision was accepted: {name!r}')
        assert (directory / 'model.usda').read_bytes() == first_bytes

    # Missing editable STEP/BREP original rejected
    broken = directory / 'revisions' / 'broken'
    broken.mkdir()
    (broken / 'model.usda').write_bytes(first_bytes)
    try:
        CAD['restore_revision'](directory, 'broken')
    except ValueError:
        pass
    else:
        raise AssertionError('A revision without an editable STEP/BREP original was accepted')

    # Invalid USD rejected
    (broken / 'model.step').write_bytes(original_step)
    for invalid in (b'#usda 1.0\n@external.usda@', b'not a USD layer'):
        (broken / 'model.usda').write_bytes(invalid)
        try:
            CAD['restore_revision'](directory, 'broken')
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid USD was accepted')
        assert (directory / 'model.usda').read_bytes() == first_bytes

    # Symlinked revision file rejected
    (broken / 'model.usda').unlink()
    (broken / 'model.usda').symlink_to(first_usd)
    try:
        CAD['restore_revision'](directory, 'broken')
    except ValueError:
        pass
    else:
        raise AssertionError('A symbolic-link revision file was accepted')

    # os.replace failure preserves preview and cleans up temp file
    with patch('os.replace', side_effect=OSError('replacement failed')):
        try:
            CAD['restore_revision'](directory, Path(second['revisionUsd']).parent.name)
        except OSError:
            pass
        else:
            raise AssertionError('Replacement failure was swallowed')
    assert (directory / 'model.usda').read_bytes() == first_bytes
    assert not list(directory.glob('.preview-*'))

print('CAD_RESTORE_REVISION_OK')
