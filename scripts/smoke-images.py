#!/usr/bin/env python3
"""Short-lived isolated process probes. No keys, network, OAuth or model requests."""
from pathlib import Path
import json
import os
import subprocess
import time

root = Path(__file__).resolve().parent.parent
rows = []
probes = {
    'llm': ('agent-memory-stack-llm:p0', ['node', '-e', "Promise.all(['/health','/ready','/v1/models'].map(async p=>{const r=await fetch('http://127.0.0.1:4010'+p);return {path:p,status:r.status}})).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1))"]),
    'embedding': ('agent-memory-stack-embedding:p0', ['python', '-c', "import urllib.request,urllib.error,json\nr=[]\nfor p in ['/health','/ready','/v1/models']:\n try:\n  with urllib.request.urlopen('http://127.0.0.1:8080'+p,timeout=2) as f:s=f.status\n except urllib.error.HTTPError as e:s=e.code\n r.append({'path':p,'status':s})\nprint(json.dumps(r))"]),
}
for service, (image, command) in probes.items():
    name = f'ams-bootstrap-check-{service}-{os.getpid()}'
    image_id = subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()
    cid = subprocess.check_output(['docker','run','--detach','--rm','--name',name,'--label','ams-bootstrap-check=temporary','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',image_id],text=True).strip()
    try:
        deadline = time.monotonic()+30
        while True:
            probe = subprocess.run(['docker','exec',cid,*command],capture_output=True,text=True)
            if probe.returncode == 0:
                results = json.loads(probe.stdout)
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f'{service} process probe timed out')
            time.sleep(0.2)
        assert [(x['path'],x['status']) for x in results] == [('/health',200),('/ready',503),('/v1/models',503)], results
        state = json.loads(subprocess.check_output(['docker','inspect',cid,'--format','{{json .HostConfig}}'],text=True))
        assert not state['Privileged'] and state['ReadonlyRootfs']
        rows.append({'service':service,'image_id':image_id,'probes':results,'privileged':False,'network':'none','host_ports':0})
    finally:
        check = subprocess.run(['docker','inspect',cid,'--format','{{.Name}} {{index .Config.Labels "ams-bootstrap-check"}}'],capture_output=True,text=True)
        if check.returncode == 0:
            assert check.stdout.strip() == f'/{name} temporary'
            subprocess.run(['docker','stop','-t','10',cid],check=True,stdout=subprocess.DEVNULL)
output = root/'docs/evidence/image-smoke.json'
output.write_text(json.dumps({'process_probes':rows,'live_oauth_or_inference':False},indent=2))
print('Both isolated production images: health=200; unconfigured ready/models=503; test containers stopped')
