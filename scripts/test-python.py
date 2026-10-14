#!/usr/bin/env python3
"""Run the independent Python application's offline tests; no shared Node package."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
project = root / 'apps' / 'embedding'
python = project / '.venv' / 'bin' / 'python'
if not python.is_file():
    raise SystemExit('Create apps/embedding/.venv and install its locked dev dependencies first; see CONTRIBUTING.md')
result = subprocess.run([str(python), '-m', 'pytest', '-q'], cwd=project, check=False)
sys.exit(result.returncode)
