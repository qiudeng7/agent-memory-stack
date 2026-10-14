"""Offline contracts for two adapter images and official OpenViking."""
import functools
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parent.parent
OFFICIAL = 'ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf'


@functools.lru_cache()
def config(layers=999):
    # Public template only, never the user's configuration or inherited credentials.
    env = {name: os.environ[name] for name in ('PATH', 'HOME') if name in os.environ}
    env['EMBEDDING_GPU_LAYERS'] = str(layers)
    result = subprocess.run(['docker', 'compose', '--env-file', '.env.example', '-f', 'compose.yml', 'config', '--format', 'json'], cwd=ROOT, env=env, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)['services']


@unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI required for static rendering')
class DeploymentTests(unittest.TestCase):
    def test_three_services_two_owned_images(self):
        services = config()
        self.assertEqual(set(services), {'llm-adapter', 'embedding', 'openviking'})
        self.assertEqual(services['openviking']['image'], OFFICIAL)
        self.assertEqual(services['openviking']['entrypoint'], ['python', '-u', '-c'])
        self.assertEqual(set(services['openviking']['depends_on']), {'llm-adapter', 'embedding'})
        for name, service in services.items():
            self.assertNotIn('profiles', service)
            self.assertNotIn('build', service)
            if name != 'openviking':
                self.assertIsNone(service.get('entrypoint'))
            self.assertFalse(service.get('privileged', False))
            self.assertNotIn('env_file', service)
            for tmpfs in service.get('tmpfs', []):
                self.assertTrue(tmpfs.startswith('/'))
            for volume in service.get('volumes', []):
                self.assertNotIn('docker.sock', volume['source'])
        binds = [v for s in services.values() for v in s.get('volumes', []) if v['type'] == 'bind']
        self.assertEqual(len(binds), 1)
        self.assertTrue(binds[0]['source'].endswith('/ov.conf'))
        self.assertTrue(binds[0]['read_only'])
        self.assertFalse(services['embedding'].get('ports'))
        for name in ('llm-adapter', 'openviking'):
            self.assertEqual(services[name]['ports'][0]['host_ip'], '127.0.0.1')

    def test_cpu_gpu_switch_is_owned_by_embedding(self):
        for layers in (0, 999):
            services = config(layers)
            embedding = services['embedding']
            self.assertEqual(embedding['environment']['EMBEDDING_GPU_LAYERS'], str(layers))
            self.assertEqual(embedding['volumes'][0]['type'], 'volume')
            self.assertEqual(embedding['volumes'][0]['target'], '/models')
            self.assertTrue(embedding['devices'])
            self.assertNotIn('EMBEDDING_ENGINE_URL', embedding['environment'])
            for service in services.values():
                self.assertIn('AMS_MASTER_KEY', service['environment'])
                self.assertFalse(any(name.endswith('_API_KEY') for name in service['environment']))
            self.assertEqual(services['llm-adapter']['environment']['LLM_PROVIDER'], 'disabled')

    def test_official_bootstrap_derives_keys_waits_and_executes(self):
        code = config()['openviking']['command'][0]
        response = MagicMock()
        response.__enter__.return_value.status = 200
        client = MagicMock()
        client.open.side_effect = [OSError('synthetic not ready'), response, response]
        with patch.dict(os.environ, {'AMS_MASTER_KEY': 'aA01' * 16}, clear=True), patch('urllib.request.build_opener', return_value=client), patch('os.chmod') as chmod, patch('signal.signal'), patch('time.sleep') as sleep, patch('os.execvp') as execute, patch('builtins.print') as output:
            namespace = {}
            exec(compile(code, '<compose-bootstrap>', 'exec'), namespace)
            chmod.assert_called_once_with('/app/.openviking', 0o700)
            sleep.assert_called_once_with(5)
            execute.assert_called_once_with('openviking-entrypoint', ['openviking-entrypoint', '--without-bot'])
            self.assertNotIn('AMS_MASTER_KEY', os.environ)
            self.assertNotIn('master', namespace)
            for name, role in [('OV_ROOT_API_KEY', 'openviking-root'), ('LLM_API_KEY', 'llm-data'), ('EMBEDDING_API_KEY', 'embedding-data')]:
                expected = hmac.new(('aA01' * 16).encode(), ('agent-memory-stack/v1/' + role).encode(), hashlib.sha256).hexdigest()
                self.assertEqual(os.environ[name], expected)
                self.assertNotIn(expected, str(output.call_args_list))

    def test_official_bootstrap_rejects_placeholder_before_calls(self):
        code = config()['openviking']['command'][0]
        with patch.dict(os.environ, {'AMS_MASTER_KEY': 'REPLACE'}, clear=True), patch('urllib.request.build_opener') as client:
            with self.assertRaises(SystemExit):
                exec(compile(code, '<compose-bootstrap>', 'exec'), {})
            client.assert_not_called()


if __name__ == '__main__':
    unittest.main()
