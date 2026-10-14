"""Test portable archives with synthetic config and observed-ID fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('package_deployment', Path(__file__).with_name('package-deployment.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ams-package-')).resolve()
        self.identity = self.root.stat()
        self.ids = {name: 'sha256:' + str(i) * 64 for i, name in enumerate(package.PUBLISHED, 1)}
        self.ids['OPENVIKING_IMAGE'] = package.OFFICIAL_OPENVIKING

    def tearDown(self):
        current = self.root.lstat()
        assert self.root.parent == Path(tempfile.gettempdir()).resolve()
        assert not self.root.is_symlink() and self.root.name.startswith('ams-package-')
        assert (current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino)
        shutil.rmtree(self.root)

    def test_only_portable_allowlist_and_no_source_secrets(self):
        path = package.create_bundle(ROOT, self.root / 'deployment.tar.gz', self.ids)
        with tarfile.open(path) as archive:
            names = archive.getnames()
            self.assertEqual(set(names), {'compose.yml', '.env.example', 'ov.conf', 'README.md', 'images.json', 'SHA256SUMS'})
            self.assertTrue(all(member.isfile() and '/' not in member.name for member in archive.getmembers()))
            contents = {name: archive.extractfile(name).read() for name in names}
        for row in contents['SHA256SUMS'].decode().splitlines():
            digest, name = row.split('  ', 1)
            self.assertEqual(hashlib.sha256(contents[name]).hexdigest(), digest)
        self.assertEqual(json.loads(contents['images.json'])['images'], self.ids)
        self.assertIn(b'AMS_MASTER_KEY=REPLACE_WITH_64_HEX_CHARACTERS', contents['.env.example'])
        for key in package.PUBLISHED:
            value = self.ids[key]
            self.assertIn((key + '=' + value).encode(), contents['.env.example'])
        # Extract only prevalidated regular names into our own isolated directory.
        for name, data in contents.items():
            (self.root / name).write_bytes(data)
        if shutil.which('docker'):
            env = {name: os.environ[name] for name in ('PATH', 'HOME') if name in os.environ}
            rendered = subprocess.run(['docker', 'compose', '--env-file', '.env.example', 'config', '--format', 'json'], cwd=self.root, env=env, capture_output=True, text=True, check=True)
            config = json.loads(rendered.stdout)
            for service in config['services'].values():
                self.assertNotIn('build', service)
                self.assertIn(service['image'], self.ids.values())
                for volume in service.get('volumes', []):
                    if volume['type'] == 'bind':
                        self.assertEqual(Path(volume['source']), self.root / 'ov.conf')
                        self.assertTrue(Path(volume['source']).exists())

    def test_published_ghcr_digests_are_preserved(self):
        references = {name: 'ghcr.io/qiudeng7/agent-memory-stack-' + component + '@sha256:' + 'a' * 64 for name, component in package.PUBLISHED.items()}
        references['OPENVIKING_IMAGE'] = package.OFFICIAL_OPENVIKING
        path = package.create_bundle(ROOT, self.root / 'ghcr.tar.gz', references)
        with tarfile.open(path) as archive:
            template = archive.extractfile('.env.example').read().decode()
            for name in package.PUBLISHED:
                self.assertIn(name + '=' + references[name], template)
            self.assertNotIn('OPENVIKING_IMAGE=', template)
            self.assertNotIn('ENGINE_IMAGE=', template)
        references['LLM_IMAGE'] = 'ghcr.io/qiudeng7/agent-memory-stack-llm:main'
        with self.assertRaises(ValueError):
            package.create_bundle(ROOT, self.root / 'mutable.tar.gz', references)

    def test_refuses_overwrite_and_invalid_ids(self):
        path = self.root / 'archive.tar.gz'
        path.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            package.create_bundle(ROOT, path, self.ids)
        self.assertEqual(path.read_bytes(), b'keep')
        with self.assertRaises(ValueError):
            package.create_bundle(ROOT, self.root / 'new.tar.gz', {})


if __name__ == '__main__':
    unittest.main()
