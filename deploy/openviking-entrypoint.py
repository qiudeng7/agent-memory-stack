"""Wait for ready adapters, then run the unmodified OpenViking entrypoint."""
import hashlib
import hmac
import os
import re
import sys
import signal
import time
import urllib.request


def configure_keys(env):
    if 'AMS_MASTER_KEY' not in env:
        validate_keys(env)
        return
    master = env['AMS_MASTER_KEY']
    roles = {'OV_ROOT_API_KEY': 'openviking-root', 'LLM_API_KEY': 'llm-data', 'EMBEDDING_API_KEY': 'embedding-data'}
    if not re.fullmatch(r'[a-fA-F0-9]{64}', master):
        raise RuntimeError('AMS_MASTER_KEY must be 64 random hex characters')
    if any(name in env or name + '_FILE' in env for name in roles):
        raise RuntimeError('Do not mix master and explicit service keys')
    for name, role in roles.items():
        env[name] = hmac.new(master.encode('ascii'), ('agent-memory-stack/v1/' + role).encode('ascii'), hashlib.sha256).hexdigest()
    del env['AMS_MASTER_KEY']


def validate_keys(env):
    for name in ('OV_ROOT_API_KEY', 'LLM_API_KEY', 'EMBEDDING_API_KEY'):
        value = env.get(name, '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', value) or value.upper().startswith('REPLACE_'):
            raise RuntimeError('Configure a master key or independent local service keys')
    if len({env[name] for name in ('OV_ROOT_API_KEY', 'LLM_API_KEY', 'EMBEDDING_API_KEY')}) != 3:
        raise RuntimeError('Local service keys must differ')


def adapters_ready():
    # Container-local service calls must not be redirected through a host proxy.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url in ('http://llm-adapter:4010/ready', 'http://embedding:8080/ready'):
        try:
            with client.open(url, timeout=5) as response:
                if response.status != 200:
                    return False
        except OSError:
            return False
    return True


def main():
    configure_keys(os.environ)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    announced = False
    while not adapters_ready():
        if not announced:
            print('Waiting for LLM and embedding readiness; OpenViking has not started.', flush=True)
            announced = True
        time.sleep(5)
    os.execvp('openviking-entrypoint', ['openviking-entrypoint', '--without-bot'])


if __name__ == '__main__':
    main()
