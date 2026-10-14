#!/usr/bin/env python3
"""Maintainer-only packaging: no build, push, login or service startup."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

IMAGES = {
    'LLM_IMAGE': 'agent-memory-stack-llm:0.1.0',
    'EMBEDDING_IMAGE': 'agent-memory-stack-embedding:0.1.0',
    'ENGINE_IMAGE': 'agent-memory-stack-engine:0.1.0',
    'OPENVIKING_IMAGE': 'agent-memory-stack-openviking:0.1.0',
}


def create_bundle(root, output, images):
    if set(images) != set(IMAGES) or not all(re.fullmatch(r'(?:ghcr\.io/[a-z0-9._/-]+@)?sha256:[0-9a-f]{64}', value) for value in images.values()):
        raise ValueError('Expected four immutable image references')
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
    contents['.env.example'] += ('\n# Immutable image references recorded by the publishing workflow.\n' + '\n'.join(f'{name}={value}' for name, value in images.items()) + '\n').encode()
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
    images = {}
    for component, name in [('llm', 'LLM_IMAGE'), ('embedding', 'EMBEDDING_IMAGE'), ('engine', 'ENGINE_IMAGE'), ('openviking', 'OPENVIKING_IMAGE')]:
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
