#!/bin/sh
# Keep the bundled CAD runtime immutable and isolated from user Python environments.
unset PYTHONHOME PYTHONPATH PYTHONUSERBASE PYTHONSTARTUP PYTHONINSPECT PYTHONOPTIMIZE VIRTUAL_ENV CONDA_PREFIX
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
runtime_dir=$(CDPATH= cd -P "$(/usr/bin/dirname "$0")" && pwd) || exit 1
export PYTHONHOME="$runtime_dir/python"
export PYTHONPATH="$runtime_dir/python/lib/python3.12/site-packages"
exec "$runtime_dir/python/bin/python3.12" -s -B "$@"
