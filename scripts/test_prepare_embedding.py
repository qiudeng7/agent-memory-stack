import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_embedding', Path(__file__).with_name('prepare-embedding.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArtifactChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ams-artifact-test-')
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / 'fixture.bin'
        self.path.write_bytes(b'public synthetic artifact')
        self.sha = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.size = self.path.stat().st_size

    def tearDown(self):
        if self.root != Path(self.temp.name).resolve() or self.root.is_symlink() or not self.root.name.startswith('ams-artifact-test-'):
            raise RuntimeError('Unsafe test cleanup target')
        self.temp.cleanup()

    def test_valid(self):
        module.verify_file(self.path, self.sha, self.size)

    def test_corruption(self):
        self.path.write_bytes(b'x' * self.size)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            module.verify_file(self.path, self.sha, self.size)

    def test_size(self):
        with self.assertRaisesRegex(ValueError, 'size/type'):
            module.verify_file(self.path, self.sha, self.size + 1)

    def test_symlink(self):
        link = self.root / 'link.bin'
        link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            module.verify_file(link, self.sha, self.size)

    def test_missing(self):
        with self.assertRaisesRegex(ValueError, 'Missing'):
            module.verify_file(self.root / 'missing.bin', self.sha, self.size)


if __name__ == '__main__':
    unittest.main()
