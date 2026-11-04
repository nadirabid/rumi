#!/bin/sh
# Keep Blender's signed resources immutable and use only its bundled Python modules.
unset PYTHONHOME PYTHONPATH PYTHONUSERBASE PYTHONSTARTUP
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
runtime_dir=$(CDPATH= cd -P "$(/usr/bin/dirname "$0")" && pwd) || exit 1
exec "$runtime_dir/Blender.app/Contents/MacOS/Blender" --python-use-system-env "$@"
