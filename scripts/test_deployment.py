"""Offline deployment contracts: render Compose and mock upstream readiness."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('ov_entrypoint', ROOT / 'deploy/openviking-entrypoint.py')
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)
KEYS = {'OV_ROOT_API_KEY': 'o' * 43, 'LLM_API_KEY': 'l' * 43, 'EMBEDDING_API_KEY': 'e' * 43}


class ReadinessTests(unittest.TestCase):
    def test_reject_missing_placeholder_and_shared_keys(self):
        for env in ({}, {**KEYS, 'LLM_API_KEY': 'REPLACE_LLM_API_KEY'}, {**KEYS, 'LLM_API_KEY': KEYS['OV_ROOT_API_KEY']}):
            with self.assertRaises(RuntimeError):
                entrypoint.validate_keys(env)
        entrypoint.validate_keys(KEYS)

    def test_master_roles_match_protocol_and_removed_before_exec(self):
        import hashlib
        import hmac
        env = {'AMS_MASTER_KEY': 'aA01' * 16}
        entrypoint.configure_keys(env)
        for name, role in [('OV_ROOT_API_KEY', 'openviking-root'), ('LLM_API_KEY', 'llm-data'), ('EMBEDDING_API_KEY', 'embedding-data')]:
            expected = hmac.new(('aA01' * 16).encode(), ('agent-memory-stack/v1/' + role).encode(), hashlib.sha256).hexdigest()
            self.assertEqual(env[name], expected)
        self.assertNotIn('AMS_MASTER_KEY', env)
        for env in ({'AMS_MASTER_KEY': ''}, {'AMS_MASTER_KEY': 'a' * 64, 'OV_ROOT_API_KEY_FILE': ''}):
            with self.assertRaises(RuntimeError):
                entrypoint.configure_keys(env)

    def test_unavailable_provider_returns_false(self):
        with patch.object(entrypoint.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = OSError('synthetic failure')
            self.assertFalse(entrypoint.adapters_ready())

    def test_checks_both_ready_endpoints(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(entrypoint.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = response
            self.assertTrue(entrypoint.adapters_ready())
            self.assertEqual(build.return_value.open.call_count, 2)

    def test_waits_then_executes_without_logging_keys(self):
        with patch.dict(os.environ, KEYS, clear=True), patch.object(entrypoint, 'adapters_ready', side_effect=[False, True]), patch.object(entrypoint.time, 'sleep') as sleep, patch.object(entrypoint.os, 'execvp') as execute, patch.object(entrypoint.signal, 'signal'), patch('builtins.print') as output:
            entrypoint.main()
            sleep.assert_called_once_with(5)
            execute.assert_called_once_with('openviking-entrypoint', ['openviking-entrypoint', '--without-bot'])
            self.assertNotIn(KEYS['OV_ROOT_API_KEY'], str(output.call_args_list))


@unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI required for static rendering')
class ComposeTests(unittest.TestCase):
    def config(self, layers):
        # Explicit public template; never load the user's .env or inherit service credentials.
        env = {name: os.environ[name] for name in ('PATH', 'HOME') if name in os.environ}
        env['EMBEDDING_GPU_LAYERS'] = str(layers)
        result = subprocess.run(['docker', 'compose', '--env-file', '.env.example', '-f', 'compose.yml', 'config', '--format', 'json'], cwd=ROOT, env=env, check=True, capture_output=True, text=True)
        return json.loads(result.stdout)['services']

    def test_four_services_no_profiles_no_secret_mounts(self):
        services = self.config(999)
        self.assertEqual(set(services), {'llm-adapter', 'embedding', 'embedding-engine', 'openviking'})
        for service in services.values():
            self.assertNotIn('profiles', service)
            self.assertNotIn('build', service)
            self.assertIsNone(service.get('entrypoint'))
            for tmpfs in service.get('tmpfs', []):
                self.assertTrue(tmpfs.startswith('/'))
            self.assertNotIn('user', service)
            self.assertFalse(service.get('privileged', False))
            self.assertNotIn('env_file', service)
            for volume in service.get('volumes', []):
                self.assertNotIn('.secrets', volume['source'])
                self.assertNotIn('docker.sock', volume['source'])
        binds = [v for s in services.values() for v in s.get('volumes', []) if v['type'] == 'bind']
        self.assertEqual(len(binds), 1)
        self.assertTrue(binds[0]['source'].endswith('/ov.conf'))
        self.assertTrue(binds[0]['read_only'])
        self.assertFalse(services['embedding'].get('ports'))
        self.assertFalse(services['embedding-engine'].get('ports'))
        for name in ('llm-adapter', 'openviking'):
            self.assertEqual(services[name]['ports'][0]['host_ip'], '127.0.0.1')

    def test_cpu_switch_and_minimal_key_distribution(self):
        for layers in (0, 999):
            services = self.config(layers)
            engine = services['embedding-engine']
            self.assertEqual(engine['environment']['EMBEDDING_GPU_LAYERS'], str(layers))
            for service in services.values():
                self.assertIn('AMS_MASTER_KEY', service['environment'])
                self.assertFalse(any(name.endswith('_API_KEY') for name in service['environment']))
            self.assertNotIn('LLM_ADMIN_API_KEY', services['openviking']['environment'])
            self.assertNotIn('OV_ROOT_API_KEY', services['llm-adapter']['environment'])
            self.assertNotIn('OV_ROOT_API_KEY', services['embedding']['environment'])
            self.assertNotIn('EMBEDDING_ADMIN_API_KEY', engine['environment'])
            self.assertEqual(services['llm-adapter']['environment']['LLM_PROVIDER'], 'disabled')
            self.assertEqual(engine['volumes'][0]['type'], 'volume')


if __name__ == '__main__':
    unittest.main()
