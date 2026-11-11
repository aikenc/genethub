#!/usr/bin/env python3
"""Install the roles that declare another machine. Entry: `run.py employee sync`.

A role belongs to the machine named by TEAM_MACHINE in its own `.genethub/open.env`.
sync builds an independent complete Team output, transfers it with GeneHub file
download and installs it once per target machine under `~/.genehub-teams/<source>`;
a target never builds author sources. `OUTPUT ROLE MACHINE ABSOLUTE_TARGET` remains
the legacy build post hook for teams that have not migrated yet.
"""
import hashlib
import importlib.util
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



def runtime_content_key(root):
    """Execution identity, after artifact verification; source bindings are provenance.

    Source-only member registration changes the builder's manifestDigest but
    not a single deployed byte. Hash all artifact/role/builder facts while
    keeping that source digest in the original immutable archive receipt.
    """
    value=read(Path(root)/'.spacebuilder/output-lock.json')
    content={'schema':'team-runtime-content/1','builder':value['builder'],
             'members':[{k:v for k,v in item.items() if k!='manifestDigest'} for item in value['members']],
             'artifacts':value['artifacts']}
    return hashlib.sha256(json.dumps(content,sort_keys=True,separators=(',',':')).encode()).hexdigest()


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
import hashlib,json,os,pathlib,subprocess,sys,zipfile,tempfile,shutil
c=json.loads(sys.argv[1])
base=pathlib.Path(c['target']) if c.get('target') else pathlib.Path.home()/'.genehub-teams'/c['source']
if c.get('parallel'):
 if c.get('target') or c.get('parallel') is not True or not c.get('roles'): raise RuntimeError('parallel install requires managed roles and no explicit target')
 c['settingsSource']=str(base)
 role_key=hashlib.sha256(json.dumps(sorted(c['roles']),separators=(',',':')).encode()).hexdigest()[:12]
 if not isinstance(c.get('contentKey'),str) or len(c['contentKey'])!=64 or any(x not in '0123456789abcdef' for x in c['contentKey']): raise RuntimeError('invalid runtime content identity')
 base=base.parent/(base.name+'.versions')/(c['contentKey']+'-'+role_key)
 if base.parent.is_symlink() or base.resolve()!=base: raise RuntimeError('parallel runtime path must not contain aliases')
c['target']=str(base); base.parent.mkdir(parents=True,exist_ok=True)
archive=base.parent/('.'+base.name+'.'+c['digest'][:16]+'.zip')
if not archive.exists():
 p=subprocess.run([os.environ['GENEHUB_CLI'],'file','download','--from',c['returnTo']['machineId'],c['archive'],str(archive),'--timeout','120'],text=True,capture_output=True,timeout=150)
 frames=[json.loads(x) for x in p.stdout.splitlines() if x.strip()]
 result=next((f.get('data',{}).get('transfer',{}) for f in reversed(frames) if f.get('type')=='transfer.result'),{})
 if p.returncode or result.get('state')!='completed': raise RuntimeError('transfer incomplete: '+p.stdout[-2000:])
if hashlib.sha256(archive.read_bytes()).hexdigest()!=c['digest']: raise RuntimeError('archive digest mismatch')
stage=pathlib.Path(tempfile.mkdtemp(prefix='.'+base.name+'.incoming-',dir=base.parent))
try:
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
finally:
 # Only this invocation's unregistered temporary copy is ours to remove.
 # Successful replacement moves it away; rollback keeps the old target or
 # its separate backup. Never sweep older stages, backups or the target.
 if stage.exists(): shutil.rmtree(stage)
'''


def installed_members(receipt):
    return receipt.get('members') or ([receipt['member']] if receipt.get('member') else [])


def accept(config):
    stage = Path(__file__).resolve().parents[1]
    requested_target = Path(config['target'])
    target = requested_target.resolve()
    if not requested_target.is_absolute() or requested_target.is_symlink() or target.is_symlink() or stage == target:
        raise RuntimeError('target must be a separate absolute runtime directory')
    owned(stage)
    if config.get('parallel') and runtime_content_key(stage)!=config.get('contentKey'):
        raise RuntimeError('parallel runtime content identity mismatch')
    roles = config.get('roles') or [config['role']]
    for role in roles:
        if not (stage/'spaces'/role/'agent-space.genet.json').is_file():
            raise RuntimeError('role missing from complete Team output: ' + role)
    from genet_builtin import team
    # Share the receiver lock outside the replaceable artifact directory.
    with team.inbox_lock(str(target.parent), 'install-' + hashlib.sha256(str(target).encode()).hexdigest(), purpose='岗位产物安装'):
        previous = read(target/'.genethub/task-source.json')
        installed = read(target/'.genethub/install-receipt.json') or {}
        same_version = (installed.get('archiveSha256') == config['digest'] or config.get('parallel')
                        and installed.get('contentKey') == config.get('contentKey'))
        if (installed.get('source') == config['source'] and same_version
                and sorted(m.get('name') for m in installed_members(installed)) == sorted(roles)):
            from genet_builtin.runtime import verify_output_artifact
            verify_output_artifact(target)
            if config.get('parallel') and runtime_content_key(target)!=config['contentKey']:
                raise RuntimeError('installed parallel content differs from its verified version')
            members = installed_members(installed)
            answer = ({'members':members,'archiveSha256':installed['archiveSha256'],'contentKey':config['contentKey']}
                      if config.get('parallel') else members if config.get('roles') else members[0])
            print(json.dumps(answer, ensure_ascii=False)); return
        if config.get('parallel'):
            # Version roots are immutable. An exact installed artifact returned
            # above; any other existing content is uncertainty, not replaceable.
            if target.exists():
                raise RuntimeError('parallel version directory lacks an exact installation receipt; original bindings retained')
            prior_root = Path(config['settingsSource'])
            if prior_root.exists():
                if prior_root.is_symlink() or prior_root.resolve()!=prior_root:
                    raise RuntimeError('target-local settings source must be a real runtime directory')
                source_route = read(prior_root/'.genethub/task-source.json')
                prior_install = read(prior_root/'.genethub/install-receipt.json') or {}
                configured_only = all(p.is_file() and p.relative_to(prior_root).as_posix().endswith('.genethub/open.env')
                                      or p.is_dir() for p in prior_root.rglob('*'))
                if not configured_only and (prior_install.get('source')!=config['source'] or not source_route
                        or source_route.get('source')!=config['source']
                        or any(source_route.get(k)!=config['returnTo'].get(k) for k in ('machineId','workspaceId'))):
                    raise RuntimeError('target-local settings have no matching source ownership receipt')
                # Transfer only opaque target-local preferences. Never clone
                # Sessions, dispatches, business data, worktrees or old results.
                for relative in [Path('.genethub/open.env')]+[Path('spaces')/role/'.genethub/open.env' for role in roles]:
                    preference=prior_root/relative
                    if preference.is_symlink():raise RuntimeError('target-local preference alias retained; no new runtime installed')
                    if preference.exists():
                        if not preference.is_file() or preference.stat().st_size>131072:
                            raise RuntimeError('target-local preferences must be bounded regular files')
                        destination=stage/relative
                        if destination.exists():raise RuntimeError('artifact unexpectedly owns target-local preferences')
                        destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(preference,destination)
        configured_only = target.exists() and all(p.is_file() and p.relative_to(target).as_posix().endswith('.genethub/open.env') or p.is_dir() for p in target.rglob('*'))
        if target.exists() and not configured_only and (not previous or previous.get('source') != config['source'] or any(previous.get(k) != config['returnTo'].get(k) for k in ('machineId','workspaceId'))):
            raise RuntimeError('target is already owned or has no install receipt; use a separate runtime directory')
        if target.exists():
            # Never replace scripts under in-flight or uncertain work.
            for receipt in target.glob('spaces/*/.genethub/team/dispatch/*.json'):
                value = read(receipt)
                request = value.get('request') if isinstance(value, dict) else None
                request_id = request.get('id') if isinstance(request, dict) else None
                # A fenced prepare never created a Session or claimed a resource.
                # Keep its exact receipt through replacement so late prepares
                # remain refused; unknown proof still blocks the installation.
                withdrawn = (isinstance(value, dict) and value.get('status') == 'withdrawn'
                             and type(value.get('fenceProtocol')) is int and value['fenceProtocol'] == 1
                             and isinstance(request_id, str) and bool(request_id)
                             and request.get('prepareOnly') is True and not request.get('operation')
                             and receipt.name == hashlib.sha256(request_id.encode()).hexdigest() + '.json'
                             and not any(key in value for key in ('sessionId', 'lock', 'directory', 'selection')))
                if not value or not (value.get('released') or withdrawn):
                    raise RuntimeError('in-flight/uncertain receipt retained; finish original task before build update')
            old_lock = read(target/'.spacebuilder/output-lock.json')
            if not old_lock and not configured_only:
                raise RuntimeError('existing runtime lacks ownership receipt; migration requires a separate target')
            old_owned = {str(Path(x['member'])/x['target']) for x in (old_lock or {}).get('artifacts',[])} | {'.spacebuilder/output-lock.json'}
            # Preserve local runtime data, including the standard business
            # worktree directory. Author inputs cannot be silently adopted.
            for child in target.rglob('*'):
                rel = child.relative_to(target)
                data = rel.parts[0] in ('datas', 'temp', 'worktrees')
                runtime = data or '.genethub' in rel.parts
                dest = stage/rel
                if child.is_symlink():
                    # Data aliases are opaque: never follow them into another
                    # tree. Artifact/control paths must still be real files.
                    if not data or str(rel) in old_owned:
                        raise RuntimeError('runtime symlink requires explicit source maintenance: '+str(rel))
                    if os.path.lexists(dest): raise RuntimeError('runtime data conflicts with new artifact: '+str(rel))
                    dest.parent.mkdir(parents=True,exist_ok=True)
                    os.symlink(os.readlink(child),dest,target_is_directory=child.is_dir())
                    continue
                if child.is_dir() and runtime:
                    dest.mkdir(parents=True,exist_ok=True)
                if child.is_file() and str(rel) not in old_owned:
                    # Only discard reproducible bytecode of an owned source.
                    # The previous installation backup retains the old cache.
                    if not runtime and rel.parent.name == '__pycache__' and rel.suffix == '.pyc':
                        try: source = Path(importlib.util.source_from_cache(str(rel)))
                        except (ValueError, NotImplementedError): source = None
                        if (source is not None and str(source) in old_owned
                                and (target/source).is_file() and not (target/source).is_symlink()):
                            continue
                    if not runtime:
                        raise RuntimeError('unowned runtime file retained; source maintenance required: '+str(rel))
                    if os.path.lexists(dest): raise RuntimeError('runtime data conflicts with new artifact: '+str(rel))
                    dest.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(child,dest)
        # Configuration is target-local. Never carry the source's absolute
        # runtime paths or credentials into the output.
        settings = stage/'.genethub/open.env'
        agent = team.open_env(str(stage)).get('TEAM_AGENT') if settings.exists() else (team.open_env(str(target)).get('TEAM_AGENT') if target.exists() else None)
        agent = agent or os.environ.get('TEAM_AGENT')
        if not agent:
            agents = team.genet('agent','list').get('agents',[])
            ready = [a for a in agents if a.get('available') is True or a.get('status') == 'ready']
            if len(ready) == 1: agent = ready[0]['id']
        if not agent:
            raise RuntimeError('target TEAM_AGENT is missing or ambiguous; on the target write TEAM_AGENT=<agent id> to %s once, then sync again' % (target/'.genethub/open.env'))
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
            machine = (team.genet('context').get('daemon') or {}).get('machineId')
            if not machine: raise RuntimeError('target daemon identity missing')
            results = []
            for role in roles:
                opened = team.genet('workspace','open',str(target/'spaces'/role))
                workspace = opened.get('workspace') or opened
                wid = workspace.get('id')
                if not wid: raise RuntimeError('registration did not return a workspace id')
                results.append(dict(name=role,machineId=machine,workspaceId=wid,command=[sys.executable,str(target/'tools/run.py')]))
            write(target/'.genethub/install-receipt.json',dict(source=config['source'],archiveSha256=config['digest'],members=results,
                 **({'contentKey':config['contentKey']} if config.get('parallel') else {})))
        except BaseException:
            os.replace(target,stage)
            if backup.exists(): os.replace(backup,target)
            raise
        # A role moved off this machine keeps its files and history but stops being an executor here.
        for member in installed_members(installed):
            if member.get('name') not in roles and member.get('workspaceId'):
                try: team.genet('workspace','remove',member['workspaceId'])
                except Exception: pass
        answer = ({'members':results,'archiveSha256':config['digest'],'contentKey':config['contentKey']}
                  if config.get('parallel') else results if config.get('roles') else results[0])
        print(json.dumps(answer,ensure_ascii=False))


def retain_archive(temporary, zipped, digest):
    """Publish immutable bytes without changing the identity of active readers."""
    try:
        os.link(temporary, zipped)
    except FileExistsError:
        if (zipped.is_symlink() or not zipped.is_file()
                or zipped.stat().st_size != temporary.stat().st_size
                or hashlib.sha256(zipped.read_bytes()).hexdigest() != digest):
            raise RuntimeError('existing content-addressed archive differs; retained for inspection')
    temporary.unlink()


def install(output, source, machine, roles, destination=None, parallel=False):
    """Transfer one verified complete Team output and install `roles` on `machine`."""
    from genet_builtin import team
    owned(output)
    route = team.source_route(str(source))
    source_id = team.projection_source(str(source),route['machineId'])
    archive_dir = source/'temp'/'artifacts'; archive_dir.mkdir(parents=True,exist_ok=True)
    # Keep both deterministic bytes and file identity stable across retries.
    # Private staging prevents another writer from modifying a published inode.
    files = owned(output)
    with tempfile.TemporaryDirectory(prefix='.archive-',dir=archive_dir) as staging:
        temporary = Path(staging)/'artifact.zip'
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
        retain_archive(temporary,zipped,digest)
    config = dict(archive=str(zipped),digest=digest,target=destination,source=source_id,returnTo=route,
                  definitionSource=dict(machineId=route['machineId'],workspaceId=route['workspaceId'],sourcePath=str(source)))
    if parallel:
        if destination is not None:raise RuntimeError('parallel installation does not replace explicit legacy targets')
        config['parallel']=True
        config['contentKey']=runtime_content_key(output)
    if destination is None: config['roles'] = roles
    else: config['role'] = roles[0]
    workspaces = team.remote_workspaces(machine)
    if not workspaces: raise RuntimeError('target has no registered workspace for installation; open one once')
    workspaces.sort(key=lambda w: (not (destination or '').startswith(team.workspace_root(w) + os.sep),not w.get('builtin',False),w['id']))
    result = shell(machine,workspaces[0]['id'], ['/bin/sh','-c','exec "$GENEHUB_PYTHON" -c "$1" "$2"','genehub-build-post',BOOTSTRAP,json.dumps(config)])
    if parallel:
        if not isinstance(result,dict) or result.get('contentKey')!=config['contentKey'] or not isinstance(result.get('members'),list):
            raise RuntimeError('parallel installation receipt could not be reconciled; previous bindings retained')
        return result['members'],result['archiveSha256']
    return (result if isinstance(result, list) else [result]), digest


def write_members(source, replace, drop=()):
    from genet_builtin import team
    descriptor = source/'agent-space.genet.json'
    with team.inbox_lock(str(source),'members',purpose='构建岗位绑定'):
        value = read(descriptor); members = value.get('members',[])
        names = {m['name'] for m in replace} | set(drop)
        value['members'] = [m for m in members if m.get('name') not in names] + replace
        write(descriptor,value)


def sync(root, parallel=False):
    from genet_builtin import team
    source = Path(root).resolve()
    hooks = ((read(source/'agent-space.genet.json') or {}).get('buildHooks') or {}).get('post') or []
    if any('install_remote.py' in ' '.join(command.get('args') or []) for command in hooks):
        raise RuntimeError('团队根仍配置旧的 install_remote 构建 hook；岗位已改用 TEAM_MACHINE，先从 buildHooks.post 删除这一项')
    plan, local = {}, []
    for role in team.child_role_names(str(source)):
        declared = team.role_machine(str(source), role)
        if declared is None: continue
        machine, here = team.machine_entry(declared)
        if here: local.append(role); continue
        plan.setdefault(machine, (declared, []))[1].append(role)
    record_path = Path(team.state_dir(str(source), 'machine-sync.json'))
    previous = (read(record_path) or {}).get('roles') or {}
    placed = {role: machine for machine, (_, roles) in plan.items() for role in roles}
    drop = sorted((set(previous) - set(placed)) | set(local))
    old_members = {m.get('name'): m for m in (read(source/'agent-space.genet.json') or {}).get('members') or []}
    # Registrations on a machine this sync does not visit stay until someone confirms no work is left there.
    retained = [dict(role=role, machineId=machine, workspaceId=(old_members.get(role) or {}).get('workspaceId'))
                for role, machine in previous.items() if placed.get(role) != machine and machine not in plan]
    report = dict(installed=[], local=sorted(set(team.child_role_names(str(source))) - set(placed)), retained=retained)
    if plan:
        try:
            builder = team.builder_script(str(source))
        except team.ExpertError as error:
            raise RuntimeError('SpaceBuilder not found (%s); set TEAM_SPACEBUILDER to spacebuilder.py' % error.what) from error
        output = Path(tempfile.mkdtemp(prefix='genehub-team-sync-'))/'team'
        try:
            built = subprocess.run([sys.executable, builder, 'build', str(source), '--output', str(output),
                                    '--require-no-post-commands', '--format', 'json'], text=True, capture_output=True, timeout=600)
            if built.returncode:
                raise RuntimeError('independent Team output build failed: ' + (built.stdout + built.stderr)[-1500:])
            for machine, (declared, roles) in plan.items():
                members, digest = install(output, source, machine, roles, parallel=parallel)
                # The source addresses the executor by the ID its own machine directory returns.
                members = [dict(m, machineId=machine) for m in members]
                write_members(source, members)
                report['installed'].append(dict(machine=declared, roles=roles, archiveSha256=digest,
                                                workspaces={m['name']: m['workspaceId'] for m in members}))
        finally:
            shutil.rmtree(output.parent, ignore_errors=True)
    if drop:
        write_members(source, [], drop)
    write(record_path, dict(roles=placed))
    print(json.dumps(report, ensure_ascii=False))


def post(output, role, machine, destination):
    from genet_builtin import team
    source = Path(os.environ.get('SPACE_SOURCE_ROOT') or Path(__file__).resolve().parents[1]).resolve()
    output = Path(output).resolve()
    if output == source:
        print(json.dumps(dict(localIdentity=True,remoteInstall=False))); return
    if not role or '/' in role or role in ('.','..','root','front','default'): raise RuntimeError('invalid execution role')
    machine = team.canonical_machine(machine)
    members, digest = install(output, source, machine, [role], destination)
    write_members(source, members)
    print(json.dumps(dict(installed=members[0],archiveSha256=digest),ensure_ascii=False))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--accept': accept(json.loads(sys.argv[2]))
        elif len(sys.argv) == 5: post(*sys.argv[1:])
        else: raise RuntimeError('run `run.py employee sync`; the legacy build hook expects OUTPUT ROLE MACHINE TARGET')
    except Exception as error:
        print(json.dumps(dict(ok=False,error=str(error)),ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
