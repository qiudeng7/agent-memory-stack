"""Optional developer helper tests; no real configuration is read."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('stack_setup', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ams-setup-')).resolve()
        self.identity = self.root.stat()
        (self.root / 'package.json').write_text(json.dumps({'name': 'agent-memory-stack'}))
        (self.root / '.env.example').write_text('AMS_MASTER_KEY=REPLACE_WITH_64_HEX_CHARACTERS\n')

    def tearDown(self):
        current = self.root.lstat()
        assert self.root.parent == Path(tempfile.gettempdir()).resolve()
        assert not self.root.is_symlink() and self.root.name.startswith('ams-setup-')
        assert (current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino)
        shutil.rmtree(self.root)

    def initialize(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            result = setup.initialize(self.root)
        return result, out.getvalue()

    def test_generates_one_key_and_no_host_directories(self):
        result, output = self.initialize()
        self.assertEqual(result, 0)
        env = self.root / '.env'
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        value = env.read_text().strip().split('=', 1)[1]
        self.assertRegex(value, '^[a-f0-9]{64}$')
        self.assertNotIn(value, output)
        self.assertFalse((self.root / 'data').exists())

    def test_repeated_run_preserves_existing_without_read(self):
        self.initialize()
        env = self.root / '.env'
        original = env.read_bytes()
        read = Path.read_text
        def only_package(path, *args, **kwargs):
            self.assertEqual(path.name, 'package.json')
            return read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', only_package), patch.object(setup.secrets, 'token_hex', side_effect=AssertionError('no rotation')):
            self.initialize()
        self.assertEqual(env.read_bytes(), original)

    def test_rejects_symlink_env(self):
        (self.root / '.env').symlink_to(self.root / 'elsewhere')
        with self.assertRaises(setup.SetupError):
            self.initialize()

    def test_bad_template_does_not_leak(self):
        (self.root / '.env.example').write_text('private-fixture')
        with contextlib.redirect_stderr(io.StringIO()) as out:
            self.assertEqual(setup.main(['--root', str(self.root)]), 1)
        self.assertNotIn('private-fixture', out.getvalue())
        self.assertFalse((self.root / '.env').exists())


if __name__ == '__main__':
    unittest.main()
