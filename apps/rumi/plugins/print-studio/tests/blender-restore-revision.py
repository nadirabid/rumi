"""Verify exact revision restoration, retained history, and failure without replacing the preview."""
import contextlib
import io
import json
import runpy
import tempfile
from pathlib import Path
from unittest.mock import patch

import bpy

root = Path(__file__).resolve().parents[1]
kit = runpy.run_path(str(root / 'blender/rumi_joints.py'))
helper = runpy.run_path(str(root / 'blender/rumi_blender.py'))
kit['start']()
box = kit['box']('Body', (10, 12, 14))
with tempfile.TemporaryDirectory(prefix='rumi-restore-') as temporary:
    directory = Path(temporary)
    first = helper['publish'](directory, check=False)
    first_usd = Path(first['revisionUsd'])
    first_bytes = first_usd.read_bytes()
    original_blend = Path(first['blend']).read_bytes()
    box.scale.x = 2
    second = helper['publish'](directory, check=False)
    second_bytes = Path(second['revisionUsd']).read_bytes()
    assert first_bytes != second_bytes
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        restored = helper['restore_revision'](directory, first_usd.parent.name)
    assert (directory / 'model.usda').read_bytes() == first_bytes
    assert Path(second['revisionUsd']).read_bytes() == second_bytes
    assert first_usd.read_bytes() == first_bytes
    assert Path(restored['blend']).read_bytes() == original_blend
    assert restored['validation'] == 'pending' and restored['printReady'] is False
    assert json.loads(output.getvalue().removeprefix('RUMI_MODEL ')) == restored
    assert box.scale.x == 2  # Restoring the preview must not silently change the open scene.
    assert len(list((directory / 'revisions').iterdir())) == 2

    for name in ('../outside', str(first_usd.parent), '.', '..', '', 'missing'):
        try:
            helper['restore_revision'](directory, name)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid revision was accepted')
        assert (directory / 'model.usda').read_bytes() == first_bytes

    broken = directory / 'revisions' / 'broken'
    broken.mkdir()
    (broken / 'model.usda').write_bytes(first_bytes)
    try:
        helper['restore_revision'](directory, 'broken')
    except ValueError:
        pass
    else:
        raise AssertionError('A revision without an editable original was accepted')
    (broken / 'model.blend').write_bytes(original_blend)
    for invalid in (b'#usda 1.0\n@external.usda@', b'not a USD layer'):
        (broken / 'model.usda').write_bytes(invalid)
        try:
            helper['restore_revision'](directory, 'broken')
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid USD was accepted')
        assert (directory / 'model.usda').read_bytes() == first_bytes
    (broken / 'model.usda').unlink()
    (broken / 'model.usda').symlink_to(first_usd)
    try:
        helper['restore_revision'](directory, 'broken')
    except ValueError:
        pass
    else:
        raise AssertionError('A symbolic-link revision file was accepted')

    with patch('os.replace', side_effect=OSError('replacement failed')):
        try:
            helper['restore_revision'](directory, Path(second['revisionUsd']).parent.name)
        except OSError:
            pass
        else:
            raise AssertionError('Replacement failure was swallowed')
    assert (directory / 'model.usda').read_bytes() == first_bytes
    assert not list(directory.glob('.preview-*'))
print('RESTORE_REVISION_OK')
