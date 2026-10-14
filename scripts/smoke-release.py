#!/usr/bin/env python3
"""Offline image probes: two owned images + official OV, synthetic fixtures only."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
LABEL = 'ams.portable-smoke'
OFFICIAL = 'ghcr.io/volcengine/openviking:v0.5.0@sha256:c60a83cd79cfce80db5266acb8bdd0908eee8abe8ff559a5f786aa504c251ccf'


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', type=Path, help='Public images.json from the deployment bundle')
    args = parser.parse_args()
    images = {'llm': 'agent-memory-stack-llm:0.1.0', 'embedding': 'agent-memory-stack-embedding:0.1.0', 'openviking': OFFICIAL}
    if args.images:
        references = json.loads(args.images.read_text())['images']
        if set(references) != {'LLM_IMAGE', 'EMBEDDING_IMAGE', 'OPENVIKING_IMAGE'} or references['OPENVIKING_IMAGE'] != OFFICIAL:
            raise ValueError('Expected two adapter images and official OpenViking')
        images = dict(zip(('llm', 'embedding', 'openviking'), (references[k] for k in ('LLM_IMAGE', 'EMBEDDING_IMAGE', 'OPENVIKING_IMAGE'))))
    ids = {name: docker('image', 'inspect', tag, '--format', '{{.Id}}') for name, tag in images.items()}
    # Render only the public template; no real .env or OAuth configuration is read.
    env = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
    rendered = subprocess.run(['docker', 'compose', '--env-file', '.env.example', 'config', '--format', 'json'], cwd=ROOT, env=env, check=True, capture_output=True, text=True)
    ov_script = json.loads(rendered.stdout)['services']['openviking']['command'][0]
    run = uuid.uuid4().hex
    containers, volumes, results = [], [], {}
    fixture = Path(tempfile.mkdtemp(prefix='ams-image-smoke-')).resolve()
    identity = fixture.stat()
    fake_engine = fixture / 'engine.py'
    fake_engine.write_text("""
import hashlib,hmac,http.server,json,os
assert os.environ['ENGINE_PORT']=='8081' and os.environ['ENGINE_BIND']=='127.0.0.1'
k=hmac.new(os.environ['AMS_MASTER_KEY'].encode(),b'agent-memory-stack/v1/embedding-engine',hashlib.sha256).hexdigest()
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get('Authorization')!='Bearer '+k:self.send_response(401);self.end_headers();return
  body={'status':'ok'} if self.path=='/health' else {'data':[{'id':'qwen3-embedding-0.6b-q8'}]}
  body=json.dumps(body).encode();self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
http.server.HTTPServer(('127.0.0.1',8081),Handler).serve_forever()
""")
    fake_engine.chmod(0o644)

    def volume(kind):
        name = f'ams-smoke-{run}-{kind}'
        docker('volume', 'create', '--label', f'{LABEL}={run}', name)
        volumes.append(name)
        return name

    def start(kind, *, mount=None, command=None, entrypoint=None, mock_engine=False, read_only=True):
        name = f'ams-smoke-{run}-{kind}-{len(containers)}'
        options = ['run', '-d', '--name', name, '--label', f'{LABEL}={run}', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-e', 'AMS_MASTER_KEY=' + 'a' * 64]
        if read_only:
            options.append('--read-only')
        if mount:
            options += ['--mount', f'type=volume,source={mount[0]},target={mount[1]}']
        if mock_engine:
            options += ['--mount', f'type=bind,source={fake_engine},target=/stack/engine-entrypoint.py,readonly']
        if entrypoint:
            options += ['--entrypoint', entrypoint]
        containers.append(name)
        docker(*options, ids[kind], *(command or []))
        return name

    try:
        oauth = volume('oauth')
        llm = start('llm', mount=(oauth, '/var/lib/ams/oauth'))
        node_probe = """
const crypto=require('node:crypto'),fs=require('node:fs');
(async()=>{
 for(let n=0;;n++){try{if((await fetch('http://127.0.0.1:4010/health')).status===200)break}catch{}if(n===100)throw Error('health');await new Promise(r=>setTimeout(r,100))}
 const k=crypto.createHmac('sha256','a'.repeat(64)).update('agent-memory-stack/v1/llm-admin').digest('hex');
 for(const [path,key,want] of [['/ready',null,503],['/admin/status',k,200],['/admin/status','a'.repeat(64),401]]){const r=await fetch('http://127.0.0.1:4010'+path,{headers:key?{Authorization:'Bearer '+key}:{}});if(r.status!==want)throw Error('status')}
 const s=fs.statSync('/var/lib/ams/oauth');if(s.uid!==1000||(s.mode&511)!==448)throw Error('permission');fs.writeFileSync('/var/lib/ams/oauth/synthetic-fixture','synthetic');
})().catch(()=>process.exit(1));
"""
        docker('exec', llm, 'node', '-e', node_probe)
        docker('stop', '-t', '5', llm)
        second = start('llm', mount=(oauth, '/var/lib/ams/oauth'), entrypoint='node', command=['-e', "if(require('node:fs').readFileSync('/var/lib/ams/oauth/synthetic-fixture','utf8')!=='synthetic')process.exit(1)"])
        if docker('wait', second) != '0':
            raise RuntimeError('OAuth volume persistence failed')
        results['llm'] = 'health200 ready503 derived-admin200 master401; OAuth volume persists UID1000/0700'

        models = volume('models')
        embedding = start('embedding', mount=(models, '/models'), mock_engine=True)
        python_probe = """
import hashlib,hmac,time,urllib.request,urllib.error
from pathlib import Path
for n in range(100):
 try:
  if urllib.request.urlopen('http://127.0.0.1:8080/ready',timeout=1).status==200:break
 except OSError:time.sleep(.1)
else:raise RuntimeError('ready')
k=hmac.new(b'a'*64,b'agent-memory-stack/v1/embedding-admin',hashlib.sha256).hexdigest()
for path,key,want in [('/health',None,200),('/admin/status',k,200),('/admin/status','a'*64,401)]:
 req=urllib.request.Request('http://127.0.0.1:8080'+path,headers={'Authorization':'Bearer '+key} if key else {})
 try:status=urllib.request.urlopen(req,timeout=5).status
 except urllib.error.HTTPError as e:status=e.code
 assert status==want
assert len(Path('/proc/1/task/1/children').read_text().split())==2
p=Path('/models');assert p.stat().st_uid==0 and p.stat().st_mode&511==448
"""
        docker('exec', embedding, 'python', '-c', python_probe)
        docker('stop', '-t', '15', embedding)
        if docker('wait', embedding) != '0':
            raise RuntimeError('Combined service SIGTERM failed')
        results['embedding'] = 'real supervisor+gateway, loopback synthetic engine; ready200 derived-admin200 master401; two children; SIGTERM exit0'

        mock_download = """
import dataclasses,hashlib,importlib.util,io,sys
s=importlib.util.spec_from_file_location('engine','/stack/engine-entrypoint.py');m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)
body=b'synthetic-model-fixture';spec=dataclasses.replace(m.MODEL,filename='fixture.gguf',size=len(body),sha256=hashlib.sha256(body).hexdigest())
class Response(io.BytesIO):
 status=200;headers={'Content-Length':str(len(body))}
 def geturl(self):return spec.url
class Opener:
 calls=0
 def open(self,*a,**kw):self.calls+=1;return Response(body)
o=Opener();p=m.prepare_model(spec=spec,opener=o);assert open(p,'rb').read()==body;m.prepare_model(spec=spec,opener=o);assert o.calls==1
"""
        downloader = start('embedding', mount=(models, '/models'), entrypoint='python', command=['-c', mock_download])
        if docker('wait', downloader) != '0':
            raise RuntimeError('Model bootstrap failed')
        docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--entrypoint', '/opt/runtime/ld-linux-x86-64.so.2', ids['embedding'], '--library-path', '/opt/runtime', '/opt/runtime/llama-server', '--version')
        results['model_runtime'] = 'embedded native loader/version exit0; synthetic cold download and warm reuse'

        ov_volume = volume('ov')
        ov = start('openviking', mount=(ov_volume, '/app/.openviking'), entrypoint='python', command=['-u', '-c', ov_script], read_only=False)
        deadline = time.monotonic() + 20
        while 'Waiting for LLM and embedding readiness' not in docker('logs', ov):
            if time.monotonic() >= deadline or docker('inspect', ov, '--format', '{{.State.Running}}') != 'true':
                raise RuntimeError('Official OV wait not observed')
            time.sleep(0.2)
        docker('exec', ov, 'python', '-c', "from pathlib import Path; import shutil; p=Path('/app/.openviking'); assert p.stat().st_uid==0 and p.stat().st_mode&511==448; (p/'synthetic-fixture').write_text('fixture'); assert shutil.which('openviking-entrypoint')")
        docker('stop', '-t', '10', ov)
        if docker('wait', ov) != '0':
            raise RuntimeError('Official OV SIGTERM failed')
        results['openviking'] = 'unchanged official image; Compose bootstrap readiness wait; SIGTERM exit0; volume root0700'
    finally:
        for name in reversed(containers):
            meta = json.loads(docker('container', 'inspect', name))[0]
            if meta['Name'] != '/' + name or meta['Config']['Labels'].get(LABEL) != run:
                raise RuntimeError('Refuse unrelated container cleanup')
            docker('container', 'rm', '-f', name)
        for name in reversed(volumes):
            meta = json.loads(docker('volume', 'inspect', name))[0]
            if meta['Name'] != name or meta['Labels'].get(LABEL) != run:
                raise RuntimeError('Refuse unrelated volume cleanup')
            docker('volume', 'rm', name)
        current = fixture.lstat()
        if fixture.parent != Path(tempfile.gettempdir()).resolve() or not fixture.name.startswith('ams-image-smoke-') or fixture.is_symlink() or (current.st_dev,current.st_ino)!=(identity.st_dev,identity.st_ino):
            raise RuntimeError('Unsafe fixture cleanup')
        shutil.rmtree(fixture)
    evidence = ROOT / 'docs/evidence/three-container-smoke.json'
    if evidence.exists():
        raise FileExistsError('Preserve existing smoke evidence')
    evidence.write_text(json.dumps({'images': images, 'image_ids': ids, 'network': 'none', 'host_ports': False, 'synthetic_only': True, 'results': results, 'cleanup': 'all test containers, volumes and fixtures removed'}, indent=2) + '\n')
    print('Two adapters and official OpenViking verified offline; test resources cleaned')


if __name__ == '__main__':
    main()
