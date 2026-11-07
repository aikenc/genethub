#!/usr/bin/env python3
"""Internal build post hook. Usage: OUTPUT ROLE MACHINE ABSOLUTE_TARGET.

No public deployment command: the source's existing build owns this operation.
Transfers use GeneHub file download; a target never builds author sources.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.new')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def owned(root):
    from genet_builtin.runtime import verify_output_artifact
    return verify_output_artifact(root, exact=True)


def cli(*args):
    command = os.environ.get('GENEHUB_CLI')
    if not command or not os.path.isabs(command):
        raise RuntimeError('missing bound GENEHUB_CLI; no channel fallback')
    done = subprocess.run([command, *args], text=True, capture_output=True, timeout=180)
    frames = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    if done.returncode or any(frame.get('error') for frame in frames):
        raise RuntimeError('GeneHub operation failed: ' + (done.stdout or done.stderr)[-2000:])
    return frames


def shell(machine, workspace, argv):
    frames = cli('shell','--machine',machine,'--workspace',workspace,'--timeout','160','--max-output','16384','--',*argv)
    end = next((f.get('data',{}) for f in frames if f.get('type') == 'shell.exit'),{})
    output = ''.join(f.get('data',{}).get('data','') for f in frames if f.get('type') == 'shell.output' and f.get('data',{}).get('stream') == 'stdout')
    if end.get('exitCode') != 0 or end.get('timedOut'):
        details = ''.join(f.get('data',{}).get('data','') for f in frames if f.get('type') == 'shell.output')
        raise RuntimeError('target operation failed; previous binding retained: ' + details[-2000:])
    return json.loads(output)


# This small bootstrap runs under the target daemon's Python. Archive bytes
# travel exclusively through file download, never through shell output.
BOOTSTRAP = r'''
import hashlib,json,os,pathlib,subprocess,sys,zipfile,tempfile
c=json.loads(sys.argv[1]); base=pathlib.Path(c['target']); base.parent.mkdir(parents=True,exist_ok=True)
archive=base.parent/('.'+base.name+'.'+c['digest'][:16]+'.zip')
if not archive.exists():
 p=subprocess.run([os.environ['GENEHUB_CLI'],'file','download','--from',c['returnTo']['machineId'],c['archive'],str(archive),'--timeout','120'],text=True,capture_output=True,timeout=150)
 frames=[json.loads(x) for x in p.stdout.splitlines() if x.strip()]
 result=next((f.get('data',{}).get('transfer',{}) for f in reversed(frames) if f.get('type')=='transfer.result'),{})
 if p.returncode or result.get('state')!='completed': raise RuntimeError('transfer incomplete: '+p.stdout[-2000:])
if hashlib.sha256(archive.read_bytes()).hexdigest()!=c['digest']: raise RuntimeError('archive digest mismatch')
stage=pathlib.Path(tempfile.mkdtemp(prefix='.'+base.name+'.incoming-',dir=base.parent))
with zipfile.ZipFile(archive) as z:
 for item in z.infolist():
  p=pathlib.PurePosixPath(item.filename)
  if p.is_absolute() or '..' in p.parts or (item.external_attr>>16)&0o170000==0o120000: raise RuntimeError('unsafe archive')
 z.extractall(stage)
 for item in z.infolist():
  if not item.is_dir(): (stage/item.filename).chmod((item.external_attr>>16)&0o777 or 0o644)
p=subprocess.run([sys.executable,'-B',str(stage/'tools/install_remote.py'),'--accept',json.dumps(c)],text=True,capture_output=True)
if p.returncode: raise RuntimeError(p.stdout+p.stderr)
print(p.stdout.strip())
'''


def accept(config):
    stage = Path(__file__).resolve().parents[1]
    requested_target = Path(config['target'])
    target = requested_target.resolve()
    if not requested_target.is_absolute() or requested_target.is_symlink() or target.is_symlink() or stage == target:
        raise RuntimeError('target must be a separate absolute runtime directory')
    files = owned(stage)
    role = config['role']
    if not (stage/'spaces'/role/'agent-space.genet.json').is_file():
        raise RuntimeError('role missing from complete Team output')
    from genet_builtin import team
    # Share the receiver lock outside the replaceable artifact directory.
    with team.inbox_lock(str(target.parent), 'install-' + hashlib.sha256(str(target).encode()).hexdigest(), purpose='岗位产物安装'):
        previous = read(target/'.genethub/task-source.json')
        installed = read(target/'.genethub/install-receipt.json') or {}
        if installed.get('source') == config['source'] and installed.get('archiveSha256') == config['digest']:
            from genet_builtin.runtime import verify_output_artifact
            verify_output_artifact(target)
            print(json.dumps(installed['member'],ensure_ascii=False)); return
        configured_only = target.exists() and all(p.is_file() and p.relative_to(target).as_posix().endswith('.genethub/open.env') or p.is_dir() for p in target.rglob('*'))
        if target.exists() and not configured_only and (not previous or previous.get('source') != config['source'] or any(previous.get(k) != config['returnTo'].get(k) for k in ('machineId','workspaceId'))):
            raise RuntimeError('target is already owned or has no install receipt; use a separate runtime directory')
        if target.exists():
            # Never replace scripts under in-flight or uncertain work.
            for receipt in target.glob('spaces/*/.genethub/team/dispatch/*.json'):
                value = read(receipt)
                if not value or not value.get('released'):
                    raise RuntimeError('in-flight/uncertain receipt retained; finish original task before build update')
            old_lock = read(target/'.spacebuilder/output-lock.json')
            if not old_lock and not configured_only:
                raise RuntimeError('existing runtime lacks ownership receipt; migration requires a separate target')
            old_owned = {str(Path(x['member'])/x['target']) for x in (old_lock or {}).get('artifacts',[])} | {'.spacebuilder/output-lock.json'}
            # Preserve only runtime configuration/data. Author inputs can never
            # be silently adopted by an artifact upgrade.
            for child in target.rglob('*'):
                rel = child.relative_to(target)
                if child.is_symlink():
                    raise RuntimeError('runtime symlink requires explicit source maintenance: '+str(rel))
                if child.is_file() and str(rel) not in old_owned:
                    if not (rel.parts[0] in ('.genethub','datas','temp') or '.genethub' in rel.parts):
                        raise RuntimeError('unowned runtime file retained; source maintenance required: '+str(rel))
                    dest = stage/rel
                    if dest.exists(): raise RuntimeError('runtime data conflicts with new artifact: '+str(rel))
                    dest.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(child,dest)
        # Configuration is target-local. Never carry the source's absolute
        # runtime paths or credentials into the output.
        settings = stage/'.genethub/open.env'
        agent = team.open_env(str(target)).get('TEAM_AGENT') if target.exists() else None
        agent = agent or os.environ.get('TEAM_AGENT')
        if not agent:
            agents = team.genet('agent','list').get('agents',[])
            ready = [a for a in agents if a.get('available') is True or a.get('status') == 'ready']
            if len(ready) == 1: agent = ready[0]['id']
        if not agent:
            raise RuntimeError('target TEAM_AGENT is missing or ambiguous; configure it once before build')
        if not settings.exists():
            settings.parent.mkdir(parents=True,exist_ok=True); settings.write_text('TEAM_AGENT='+agent+'\n',encoding='utf-8')
        write(stage/'.genethub/task-source.json',dict(config['returnTo'],source=config['source']))
        write(stage/'.genethub/definition-source.json',config['definitionSource'])
        backup = Path(tempfile.mkdtemp(prefix='.'+target.name+'.previous-',dir=target.parent)); backup.rmdir()
        if target.exists(): os.replace(target,backup)
        try: os.replace(stage,target)
        except BaseException:
            if backup.exists(): os.replace(backup,target)
            raise
        # Registration can be retried after a lost response; workspace.open is
        # idempotent for the same path. The old binding is not changed on error.
        try:
            opened = team.genet('workspace','open',str(target/'spaces'/role))
            workspace = opened.get('workspace') or opened
            wid = workspace.get('id')
            if not wid: raise RuntimeError('registration did not return a workspace id')
            machine = (team.genet('context').get('daemon') or {}).get('machineId')
            if not machine: raise RuntimeError('target daemon identity missing')
            result = dict(name=role,machineId=machine,workspaceId=wid,command=[sys.executable,str(target/'tools/run.py')])
            write(target/'.genethub/install-receipt.json',dict(source=config['source'],archiveSha256=config['digest'],member=result))
        except BaseException:
            os.replace(target,stage)
            if backup.exists(): os.replace(backup,target)
            raise
        print(json.dumps(result,ensure_ascii=False))



def post(output, role, machine, destination):
    from genet_builtin import team
    source = Path(os.environ.get('SPACE_SOURCE_ROOT') or Path(__file__).resolve().parents[1]).resolve()
    output = Path(output).resolve()
    if output == source:
        print(json.dumps(dict(localIdentity=True,remoteInstall=False))); return
    if not role or '/' in role or role in ('.','..','root','front','default'): raise RuntimeError('invalid execution role')
    machine = team.canonical_machine(machine)
    files = owned(output)
    route = team.source_route(str(source))
    source_id = team.projection_source(str(source),route['machineId'])
    archive_dir = source/'temp'/'artifacts'; archive_dir.mkdir(parents=True,exist_ok=True)
    # Deterministic archive path and bytes make retries reuse the same download.
    zipped = archive_dir/(hashlib.sha256((role+machine+destination).encode()).hexdigest()+'.zip')
    temporary = zipped.with_suffix('.new')
    with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED) as z:
        for directory in sorted(p for p in output.rglob('*') if p.is_dir()):
            z.writestr(zipfile.ZipInfo(directory.relative_to(output).as_posix()+'/',date_time=(2020,1,1,0,0,0)),b'')
        for relative in sorted(files):
            child = output/relative
            if child.is_file():
                info = zipfile.ZipInfo(child.relative_to(output).as_posix(),date_time=(2020,1,1,0,0,0))
                info.external_attr = (stat.S_IFREG | stat.S_IMODE(child.stat().st_mode)) << 16
                z.writestr(info,child.read_bytes())
    digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
    zipped = archive_dir/(digest+'.zip')
    os.replace(temporary,zipped)
    config = dict(archive=str(zipped),digest=digest,target=destination,role=role,returnTo=route,source=source_id,definitionSource=dict(machineId=route['machineId'],workspaceId=route['workspaceId'],sourcePath=str(source)))
    workspaces = team.remote_workspaces(machine)
    if not workspaces: raise RuntimeError('target has no registered workspace for installation; open one once')
    workspaces.sort(key=lambda w: (not destination.startswith(team.workspace_root(w) + os.sep),not w.get('builtin',False),w['id']))
    result = shell(machine,workspaces[0]['id'], ['/bin/sh','-c','exec "$GENEHUB_PYTHON" -c "$1" "$2"','genehub-build-post',BOOTSTRAP,json.dumps(config)])
    descriptor = source/'agent-space.genet.json'
    with team.inbox_lock(str(source),'members',purpose='构建岗位绑定'):
        value = read(descriptor); members = value.get('members',[])
        value['members'] = [m for m in members if m.get('name') != role] + [result]
        write(descriptor,value)
    print(json.dumps(dict(installed=result,archiveSha256=config['digest']),ensure_ascii=False))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--accept': accept(json.loads(sys.argv[2]))
        elif len(sys.argv) == 5: post(*sys.argv[1:])
        else: raise RuntimeError('internal build hook expects OUTPUT ROLE MACHINE TARGET')
    except Exception as error:
        print(json.dumps(dict(ok=False,error=str(error)),ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
