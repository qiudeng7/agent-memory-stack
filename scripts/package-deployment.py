#!/usr/bin/env python3
"""Maintainer-only packaging: no build, push, login or service startup."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

OFFICIAL_OPENVIKING = 'ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf'
PUBLISHED = {'LLM_IMAGE': 'llm', 'EMBEDDING_IMAGE': 'embedding'}
IMAGES = {**PUBLISHED, 'OPENVIKING_IMAGE': OFFICIAL_OPENVIKING}


def create_bundle(root, output, images):
    if set(images) != set(IMAGES) or images.get('OPENVIKING_IMAGE') != OFFICIAL_OPENVIKING or not all(re.fullmatch(r'(?:ghcr\.io/[a-z0-9._/-]+@)?sha256:[0-9a-f]{64}', images[name]) for name in PUBLISHED):
        raise ValueError('Expected two immutable adapter images and fixed official OpenViking')
    output = Path(output).absolute()
    if output.resolve(strict=False) != output or output.is_symlink():
        raise ValueError('Unsafe bundle destination')
    source_files = {'compose.yml': 'compose.yml', '.env.example': '.env.example', 'ov.conf': 'ov.conf', 'README.md': 'docs/deployment.md'}
    contents = {}
    for name, relative in source_files.items():
        source = root / relative
        if source.is_symlink() or not source.is_file():
            raise ValueError('Invalid deployment input')
        contents[name] = source.read_bytes()
    contents['.env.example'] += ('\n# Immutable image references recorded by the publishing workflow.\n' + '\n'.join(f'{name}={images[name]}' for name in PUBLISHED) + '\n').encode()
    contents['images.json'] = (json.dumps({'platform': 'linux/amd64', 'images': images}, indent=2) + '\n').encode()
    contents['SHA256SUMS'] = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(contents.items())).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream, tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name, data in contents.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--references', type=Path, required=True, help='Downloaded image-* Actions artifacts directory')
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent.parent / 'dist')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    images = {'OPENVIKING_IMAGE': OFFICIAL_OPENVIKING}
    for name, component in PUBLISHED.items():
        reference = json.loads((args.references / ('image-' + component) / 'image-reference.json').read_text())
        if set(reference) != {component} or not reference[component].startswith('ghcr.io/'):
            raise ValueError('Invalid publishing reference')
        images[name] = reference[component]
    output = args.output_dir.absolute()
    if output.resolve(strict=False) != output or output.is_symlink():
        raise ValueError('Unsafe output directory')
    bundle = create_bundle(root, output / 'agent-memory-stack-deploy.tar.gz', images)
    print(f'Created {bundle.name}: standalone GHCR deployment templates')


if __name__ == '__main__':
    main()
