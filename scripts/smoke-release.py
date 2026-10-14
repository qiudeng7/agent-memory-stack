#!/usr/bin/env python3
"""Isolated offline production-image probes; synthetic credentials and volumes only."""
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
LABEL = 'ams.portable-smoke'


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout.strip()


def main():
    run = uuid.uuid4().hex
    containers, volumes = [], []
    images = {name: f'agent-memory-stack-{name}:0.1.0' for name in ('llm', 'embedding', 'engine', 'openviking')}
    ids = {name: docker('image', 'inspect', tag, '--format', '{{.Id}}') for name, tag in images.items()}
    results = {}

    def volume(kind):
        name = f'ams-smoke-{run}-{kind}'
        docker('volume', 'create', '--label', f'{LABEL}={run}', name)
        volumes.append(name)
        return name

    def start(kind, *, mount=None, command=None, entrypoint=None, read_only=True):
        name = f'ams-smoke-{run}-{kind}-{len(containers)}'
        args = ['run', '-d', '--name', name, '--label', f'{LABEL}={run}', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-e', 'AMS_MASTER_KEY=' + 'a' * 64]
        if read_only:
            args += ['--read-only']
        if mount:
            args += ['--mount', f'type=volume,source={mount[0]},target={mount[1]}']
        if entrypoint:
            args += ['--entrypoint', entrypoint]
        containers.append(name)
        docker(*args, ids[kind], *(command or []))
        return name

    try:
        oauth = volume('oauth')
        llm = start('llm', mount=(oauth, '/var/lib/ams/oauth'))
        node_probe = """
const crypto=require('node:crypto'), fs=require('node:fs');
(async()=>{
 let ok=false;for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:4010/health')).status===200){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,100))};if(!ok)throw Error('health');
 const k=crypto.createHmac('sha256','a'.repeat(64)).update('agent-memory-stack/v1/llm-admin').digest('hex');
 for(const [path,key,want] of [['/ready',null,503],['/admin/status',k,200],['/admin/status','a'.repeat(64),401]]){const r=await fetch('http://127.0.0.1:4010'+path,{headers:key?{Authorization:'Bearer '+key}:{}});if(r.status!==want)throw Error('status')}
 const s=fs.statSync('/var/lib/ams/oauth');if(s.uid!==1000||(s.mode&511)!==448)throw Error('volume permission');fs.writeFileSync('/var/lib/ams/oauth/synthetic-fixture','synthetic');console.log('ok');
})().catch(()=>process.exit(1));
"""
        docker('exec', llm, 'node', '-e', node_probe)
        docker('stop', '-t', '5', llm)
        second = start('llm', mount=(oauth, '/var/lib/ams/oauth'), entrypoint='node', command=['-e', "if(require('node:fs').readFileSync('/var/lib/ams/oauth/synthetic-fixture','utf8')!=='synthetic')process.exit(1)"])
        if docker('wait', second) != '0':
            raise RuntimeError('OAuth volume persistence failed')
        results['llm'] = 'health200 ready503 derived-admin200 master401; OAuth volume UID1000 mode0700 persists'

        embedding = start('embedding')
        python_probe = """
import hashlib,hmac,time,urllib.request,urllib.error
for n in range(100):
 try:
  if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=1).status==200:break
 except OSError:time.sleep(.1)
else:raise RuntimeError('health')
k=hmac.new(b'a'*64,b'agent-memory-stack/v1/embedding-admin',hashlib.sha256).hexdigest()
for path,key,want in [('/ready',None,503),('/admin/status',k,200),('/admin/status','a'*64,401)]:
 req=urllib.request.Request('http://127.0.0.1:8080'+path,headers={'Authorization':'Bearer '+key} if key else {})
 try:status=urllib.request.urlopen(req,timeout=5).status
 except urllib.error.HTTPError as e:status=e.code
 assert status==want
print('ok')
"""
        docker('exec', embedding, 'python', '-c', python_probe)
        results['embedding'] = 'health200 ready503 derived-admin200 master401'

        model_volume = volume('models')
        mock_download = """
import dataclasses,hashlib,importlib.util,io,os,sys
s=importlib.util.spec_from_file_location('engine','/stack/engine-entrypoint.py');m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)
assert os.stat('/models').st_uid==0 and os.stat('/models').st_mode&511==448
body=b'synthetic-model-fixture';spec=dataclasses.replace(m.MODEL,filename='fixture.gguf',size=len(body),sha256=hashlib.sha256(body).hexdigest())
class Response(io.BytesIO):
 status=200;headers={'Content-Length':str(len(body))}
 def geturl(self):return spec.url
class Opener:
 calls=0
 def open(self,*a,**kw):self.calls+=1;return Response(body)
o=Opener();p=m.prepare_model(spec=spec,opener=o);assert open(p,'rb').read()==body;m.prepare_model(spec=spec,opener=o);assert o.calls==1
print('ok')
"""
        engine = start('engine', mount=(model_volume, '/models'), entrypoint='python', command=['-c', mock_download])
        if docker('wait', engine) != '0':
            raise RuntimeError('Engine volume/bootstrap smoke failed')
        version = docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--entrypoint', '/opt/runtime/ld-linux-x86-64.so.2', ids['engine'], '--library-path', '/opt/runtime', '/opt/runtime/llama-server', '--version')
        # llama writes version to stderr on this revision; exit0 proves loader execution.
        results['engine'] = 'native loader/version exit0; synthetic cold download+warm reuse; model volume root0700'

        ov_volume = volume('ov')
        ov = start('openviking', mount=(ov_volume, '/app/.openviking'), read_only=False)
        docker('exec', ov, 'python', '-c', "from pathlib import Path; import os,shutil; p=Path('/app/.openviking'); assert p.stat().st_uid==0 and p.stat().st_mode&511==448; (p/'synthetic-fixture').write_text('fixture'); assert shutil.which('openviking-entrypoint')")
        deadline = time.monotonic() + 20
        while 'Waiting for LLM and embedding readiness' not in docker('logs', ov):
            if time.monotonic() >= deadline or docker('inspect', ov, '--format', '{{.State.Running}}') != 'true':
                raise RuntimeError('OV readiness wait not observed')
            time.sleep(0.2)
        docker('stop', '-t', '10', ov)
        if docker('wait', ov) != '0':
            raise RuntimeError('OV SIGTERM handling failed')
        results['openviking'] = 'built-in readiness wait and SIGTERM exit0; root0700 volume writable with dropALL'
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
    evidence = ROOT / 'docs/evidence/portable-image-smoke.json'
    evidence.write_text(json.dumps({'images': ids, 'network': 'none', 'host_ports': False, 'synthetic_only': True, 'results': results, 'cleanup': 'all test containers and volumes removed'}, indent=2) + '\n')
    print('Four packaged images verified offline; isolated volumes cleaned')


if __name__ == '__main__':
    main()
