#!/usr/bin/env python3
"""Verify project-local model/runtime and refresh the engine build context metadata."""
from pathlib import Path
import hashlib
import json
import os
import stat

MODEL_NAME = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
MODEL_SHA = '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
MODEL_SIZE = 639150592


def verify_file(path: Path, sha256: str, size: int) -> None:
    if path.is_symlink() or path.resolve(strict=False) != path:
        raise ValueError('Artifact path or ancestor must not be a symlink')
    if not path.is_file():
        raise ValueError(f'Missing project artifact: {path.name}')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != size:
            raise ValueError(f'Artifact size/type mismatch: {path.name}')
        if hashlib.file_digest(file, 'sha256').hexdigest() != sha256:
            raise ValueError(f'Artifact checksum mismatch: {path.name}')


def sync_metadata(source: Path, destination: Path) -> None:
    if destination.is_symlink() or destination.resolve(strict=False) != destination:
        raise ValueError('Build context metadata must not use a symlink')
    data = source.read_bytes()
    if destination.exists():
        if not destination.is_file():
            raise ValueError('Build context metadata must be an ordinary file')
        if destination.read_bytes() == data:
            return
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def prepare(root: Path) -> int:
    if json.loads((root / 'package.json').read_text())['name'] != 'agent-memory-stack':
        raise ValueError('Unexpected project')
    model = json.loads((root / 'docs/evidence/qwen3-model-manifest.json').read_text())['file']
    if model['rfilename'] != MODEL_NAME or model['size'] != MODEL_SIZE or model['lfs']['sha256'] != MODEL_SHA:
        raise ValueError('Unexpected pinned model manifest')
    verify_file(root / 'data/models' / MODEL_NAME, MODEL_SHA, MODEL_SIZE)
    recipe = root / 'deploy/embedding-engine'
    context = root / '.runtime/embedding-engine'
    rows = json.loads((recipe / 'runtime-manifest.json').read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError('Invalid runtime manifest')
    names: set[str] = set()
    for row in rows:
        name = row['name']
        if not isinstance(name, str) or Path(name).name != name or name in {'.', '..'} or name in names:
            raise ValueError('Invalid or duplicate runtime filename')
        names.add(name)
        verify_file(context / 'runtime' / name, row['sha256'], row['size'])
    for name in ['Dockerfile', 'radeon_icd.json', 'amdgpu.ids', 'runtime-manifest.json', 'llama-LICENSE']:
        sync_metadata(recipe / name, context / name)
    return len(rows)


if __name__ == '__main__':
    try:
        count = prepare(Path(__file__).resolve().parent.parent)
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit(str(error)) from None
    print(f'Project assets verified: model + {count} runtime files; engine build context ready')
