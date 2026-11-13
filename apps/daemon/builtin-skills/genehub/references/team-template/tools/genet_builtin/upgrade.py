"""Latest-only, resumable source upgrades; existing installer owns execution copies.

Candidates are unregistered files, not Teams. Conflicts, failed regression and
source edits need reflection; an occupied/unknown execution safe point waits.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
from .update_gate import SafePointBusy


class Conflict(Exception):
    def __init__(self, files, reason):
        self.files = files
        super().__init__(reason)


def register(sub):
    command = sub.add_parser('upgrade', help='merge, verify and install the latest compatible platform template')
    command.add_argument('--status', action='store_true', help='read the latest upgrade outcome')
    command.add_argument('--worker', help='resume the durable generation selected by the timer')
    command.add_argument('--base', help='full ancestor commit explicitly reviewed by the Team for legacy unrelated history')


def location(t, root):
    return Path(t.state_dir(root, 'upgrade', 'latest.json'))


def store(t, root, row, status=None, **fields):
    row.update(fields, updatedAtMs=t.now_ms())
    if status:
        row['status'] = status
    t.write_json(str(location(t, root)), row)
    source_changes = status == 'waiting-safe-point' and row.get('reason') == 'uncommitted-source-changes'
    if status in ('conflict', 'test-failure') or source_changes:
        # One signal for this exact candidate/cause. No success/transient wait messages.
        # Source edits require an owner's decision, rather than a lock that
        # becomes safe by waiting. Reuse the existing note lifecycle once per
        # target: further WIP edits must not create another wake or auto-commit.
        kind = 'source-changes' if source_changes else status
        context = {k: row.get(k) for k in ('target', 'reason', 'conflictFiles', 'failedCommand',
                                         'dirtyPaths', 'dirtyPathCount', 'dirtyPathsTruncated', 'reviewedBase')}
        context['maintenanceArgv'] = [sys.executable, '-B',
            str(Path(row.get('template') or t.template_dir(root))/'tools/run.py'),
            '--team-root', str(Path(root).resolve()), 'upgrade']
        if row.get('reviewedBase'):
            context['maintenanceArgv'] += ['--base', row['reviewedBase']]
        # Existing Teams already recognize upgrade as urgent; a new note kind
        # would itself require adoption before it could wake their old hook.
        t.add_note(root, {'kind': 'upgrade' if source_changes else 'upgrade-' + kind, 'from': 'platform',
                         'session': None, 'quote': '', 'context': json.dumps(
                             context, ensure_ascii=False),
                         'text': '平台升级等待未提交源修改处理' if source_changes else '平台升级需要处理：' + status},
                   'upgrade', row['target'], kind, row.get('reason', ''))
    return row


def invoke(argv, cwd, timeout=180, env=None):
    result = subprocess.run(argv, cwd=str(cwd), env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(' '.join(str(x) for x in argv[:4]) + ': ' +
                           (result.stderr or result.stdout).decode('utf-8', 'replace')[-1600:])
    return result.stdout


def git(t, root, *args, env=None):
    return t.git(root, *args, env=env).stdout


def clean(t, root):
    return not git(t, root, 'status', '--porcelain').strip()


def source_identity(t, root, head):
    """Validation inputs, excluding the reflection's own narrative commits.

    Keep tools, tests, settings and custom files. A Git ancestry correction is
    also an input even if it leaves file bytes unchanged. Never rewrite refs
    to make unrelated histories appear compatible.
    """
    tree = git(t, root, 'ls-tree', '-r', '-z', head)
    entries = tree.split(b'\0')
    if len(tree) > 2*1024*1024 or len(entries) > 10001:
        raise Conflict([], 'source-file-bound-exceeded')
    digest = hashlib.sha256()
    for entry in entries:
        if not entry:
            continue
        path = entry.split(b'\t', 1)[1].decode('utf-8')
        parts = Path(path).parts
        if (path in ('memory.md', 'front/index.md', 'front/memory.md')
                or path.startswith('docs/reflection/')
                or len(parts) == 3 and parts[0] == 'spaces' and parts[2] in ('index.md', 'memory.md')):
            continue
        digest.update(entry + b'\0')
    base = t.git(root, 'merge-base', head, t.platform_ref(root), check=False)
    if base.returncode not in (0, 1):
        raise RuntimeError('merge-base failed: ' + base.stderr.decode('utf-8', 'replace')[-1600:])
    digest.update(b'ancestry\0' + base.stdout.strip())
    return digest.hexdigest()


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        stat = Path('/proc')/str(pid)/'stat'
        if stat.is_file() and stat.read_text().rsplit(')', 1)[-1].strip().startswith('Z'):
            return False
        return True
    except (ProcessLookupError, FileNotFoundError):
        return False
    except PermissionError:
        return True


def delegate_legacy_notes(t, root, target):
    """Old platform notifications become one automatic operation, not work
    for nine reflection rounds. Preserve originals and record delegation,
    never an assertion that installation/adoption has already succeeded.
    """
    delegated = []
    with t.inbox_lock(root, 'upgrade-notes', purpose='升级通知迁移'):
        for source in Path(t.notes_dir(root)).glob('*.json'):
            raw = source.read_bytes()
            note = t.read_json(str(source)) or {}
            if (note.get('id') != source.stem or note.get('kind') != 'upgrade'
                    or note.get('from') != 'platform' or not str(note.get('text', '')).startswith('template ')):
                continue
            destination = Path(t.notes_dir(root, True))/source.name
            if destination.exists():
                continue  # retain an uncertain collision, never overwrite history
            t.write_json(str(destination), dict(note, handledAtMs=t.now_ms(),
                         result='delegated-to-automatic-upgrade; adoption is not yet asserted',
                         automaticUpgradeTarget=target))
            if source.read_bytes() == raw:
                source.unlink()
                delegated.append(note['id'])
    return delegated


def selection(t, root):
    template = t.template_dir(root)
    return template, t.template_digest(template)


def reviewed_base(t, root, head, base):
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', base):
        raise Conflict([], 'invalid-reviewed-baseline; provide a full immutable ancestor commit')
    result = t.git(root, 'rev-parse', '--verify', base + '^{commit}', check=False)
    if result.returncode:
        raise Conflict([], 'invalid-reviewed-baseline; commit not found')
    base = result.stdout.decode().strip()
    result = t.git(root, 'merge-base', '--is-ancestor', base, head, check=False)
    if result.returncode == 1:
        raise Conflict([], 'reviewed-baseline-not-ancestor; retain the original source')
    if result.returncode:
        raise RuntimeError('baseline ancestry check failed: ' + result.stderr.decode('utf-8', 'replace')[-1600:])
    # Some legacy repos labelled complete Team snapshots as "platform".
    # Such a tree is not a comparison base for removing platform files: it
    # also contains the Team's own documents and custom definitions.
    subject = t.git_text(root, 'show', '-s', '--format=%s', base)
    recorded = re.fullmatch(r'platform: ([0-9a-f]{16})', subject)
    if not recorded:
        raise Conflict([], 'unverified-platform-baseline; select the original intact platform snapshot')
    with tempfile.TemporaryDirectory(prefix='team-upgrade-baseline-') as scratch:
        extract(t, root, base, Path(scratch))
        if t.template_digest(scratch) != recorded.group(1):
            raise Conflict([], 'unverified-platform-baseline; platform label does not match snapshot contents')
    return base


def schedule(t, root, base=None):
    if t.is_deployed_output(root):
        return {'status': 'waiting-safe-point', 'reason': 'managed-at-definition-source'}
    with t.inbox_lock(root, 'upgrade-worker', purpose='平台升级'):
        previous = t.read_json(str(location(t, root)), {}) or {}
        if alive(previous.get('workerPid')):
            return previous
        template, target = selection(t, root)
        delegated = delegate_legacy_notes(t, root, target)
        head = t.git_text(root, 'rev-parse', 'HEAD') if t.has_repo(root) else None
        if previous.get('status') == 'adopted' and previous.get('target') == target:
            from .template_version import fingerprint
            if fingerprint(root)[0] == previous.get('templateId'):
                return previous  # normal memory/identity commits are not another platform version
        if not head or not t.platform_ref(root):
            row = dict(schema='team-upgrade/1', target=target, head=head)
            return store(t, root, row, 'conflict', reason='missing-platform-baseline', conflictFiles=[])
        if not clean(t, root):
            waiting = previous if previous.get('sourceApplied') and previous.get('target') == target else dict(schema='team-upgrade/1', target=target, head=head)
            changes = iter(git(t, root, 'status', '--porcelain', '-z').decode().split('\0'))
            paths = []
            for entry in changes:
                if not entry:
                    continue
                paths.append(entry[3:])
                if 'R' in entry[:2] or 'C' in entry[:2]:
                    next(changes, None)  # porcelain -z names the old path separately
            return store(t, root, waiting,
                         'waiting-safe-point', reason='uncommitted-source-changes', template=template,
                         dirtyPaths=[x[:512] for x in paths[:64]], dirtyPathCount=len(paths),
                         dirtyPathsTruncated=len(paths) > 64 or any(len(x) > 512 for x in paths))
        # A choice belongs only to this platform target, never to future
        # releases. Ordinary timer retries may resume the exact prior choice.
        if base is None and previous.get('target') == target:
            base = previous.get('reviewedBase')
        if base is not None:
            try:
                base = reviewed_base(t, root, head, base)
            except Conflict as error:
                return store(t, root, dict(schema='team-upgrade/1', target=target, head=head),
                             'conflict', reason=str(error), conflictFiles=error.files)
        inputs = source_identity(t, root, head)
        if (previous.get('target') == target and previous.get('status') in ('conflict', 'test-failure')
                and previous.get('reviewedBase') == base
                and previous.get('sourceIdentity') == inputs):
            return previous  # recording the failure is not a new repair attempt
        if (previous.get('sourceApplied') and previous.get('target') == target
                and previous.get('head') == head and previous.get('status') == 'waiting-safe-point'):
            row = previous
            row['startedAtMs'] = t.now_ms()
        else:
            row = None
        if (previous.get('target') == target and previous.get('head') == head
                and previous.get('reviewedBase') == base
                and previous.get('sourceIdentity') == inputs
                and previous.get('status') in ('adopted', 'conflict', 'test-failure')):
            return previous
        row = row or dict(schema='team-upgrade/1', target=target, head=head, template=template,
                          startedAtMs=t.now_ms(), sourceIdentity=inputs,
                          generation=hashlib.sha256((target + '\0' + head + '\0' + (base or '')).encode()).hexdigest()[:24])
        if base is not None:
            row['reviewedBase'] = base
        row['delegatedNotes'] = sorted(set(row.get('delegatedNotes', [])) | set(delegated))
        directory = Path(t.state_dir(root, 'upgrade', row['generation']))
        directory.mkdir(parents=True, exist_ok=True)
        store(t, root, row, 'waiting-safe-point', reason='validating-candidate')
        with (directory/'worker.log').open('ab') as log:
            entry = Path(sys.argv[0]).resolve()
            selector = [] if entry == (Path(root)/'tools/run.py').resolve() else ['--team-root', str(root)]
            process = subprocess.Popen([sys.executable, '-B', str(entry), *selector,
                                        'upgrade', '--worker', row['generation']], cwd=root,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        row['workerPid'] = process.pid
        return store(t, root, row)


def merge_tree(t, root, row, directory):
    # Record the new platform as a comparison branch, never as adoption.
    t.platform_commit(root, row['template'])
    platform = t.git_text(root, 'rev-parse', t.platform_ref(root))
    ancestry = t.git(root, 'merge-base', row['head'], platform, check=False)
    if ancestry.returncode == 1:
        if not row.get('reviewedBase'):
            raise Conflict([], 'no-common-ancestor; review the original platform baseline, then upgrade --base <full-ancestor-commit>')
        base = reviewed_base(t, root, row['head'], row['reviewedBase'])
        row['mergeBaseMode'] = 'reviewed'
    elif ancestry.returncode:
        raise RuntimeError('merge-base failed: ' + ancestry.stderr.decode('utf-8', 'replace')[-1600:])
    else:
        base = ancestry.stdout.decode().strip()
        row['mergeBaseMode'] = 'common-ancestor'
    row['mergeBase'] = base
    local = set(git(t, root, 'diff', '--name-only', '-z', base, row['head']).decode().split('\0'))
    changed = set(git(t, root, 'diff', '--name-only', '-z', base, platform).decode().split('\0'))
    different = set(git(t, root, 'diff', '--name-only', '-z', row['head'], platform).decode().split('\0'))
    builtin = ('tools/genet_builtin/', 'skills/genet_builtin/')
    # Exact blob+mode equality is already integrated, not a semantic merge.
    # Different overlapping builtin patches remain explicit review work even
    # when Git could combine their text without conflict markers.
    risks = sorted(p for p in local & changed & different if p.startswith(builtin) or p == 'tools/run.py')
    if risks:
        raise Conflict(risks, 'local-builtin-patch-overlaps-platform; review protocol semantics before merging')
    # Old Git supports this read-only preflight, but not --write-tree.
    probe = t.git(root, 'merge-tree', base, row['head'], platform, check=False)
    (directory/'merge-preflight.txt').write_bytes(probe.stdout[:256*1024])
    index = directory/'candidate.index'
    if index.exists():
        index.unlink()
    env = dict(os.environ, GIT_INDEX_FILE=str(index))
    git(t, root, 'read-tree', '-i', '-m', base, row['head'], platform, env=env)
    unresolved = git(t, root, 'ls-files', '-u', '-z', env=env)
    groups = {}
    for value in unresolved.split(b'\0'):
        if not value:
            continue
        meta, path = value.split(b'\t', 1)
        mode, sha, stage = meta.decode().split()
        groups.setdefault(path.decode(), {})[int(stage)] = (mode, sha)
    conflicts = []
    for number, (path, versions) in enumerate(groups.items()):
        if set(versions) != {1, 2, 3} or len({v[0] for v in versions.values()}) != 1 or versions[2][0] == '120000':
            conflicts.append(path)
            continue
        parts = []
        for stage in (2, 1, 3):
            file = directory/('merge-%s-%s' % (number, stage))
            file.write_bytes(git(t, root, 'cat-file', 'blob', versions[stage][1]))
            parts.append(str(file))
        merged = subprocess.run(['git', 'merge-file', '-p', *parts], capture_output=True, timeout=30)
        if merged.returncode:
            conflicts.append(path)
            continue
        blob = t.git(root, 'hash-object', '-w', '--stdin', input=merged.stdout).stdout.decode().strip()
        git(t, root, 'update-index', '--force-remove', '--', path, env=env)
        git(t, root, 'update-index', '--add', '--cacheinfo', versions[2][0] + ',' + blob + ',' + path, env=env)
    if conflicts:
        raise Conflict(sorted(conflicts), 'three-way-merge-conflict')
    tree = git(t, root, 'write-tree', env=env).decode().strip()
    return platform, tree


def extract(t, root, tree, candidate):
    archive = git(t, root, 'archive', '--format=tar', tree)
    if len(archive) > 64*1024*1024:
        raise Conflict([], 'candidate-exceeds-64MiB')
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = tar.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 64*1024*1024:
            raise Conflict([], 'candidate-file-bound-exceeded')
        for member in members:
            path = Path(member.name)
            if (path.is_absolute() or '..' in path.parts or '\\' in member.name or ':' in member.name
                    or not (member.isfile() or member.isdir())):
                raise Conflict([member.name], 'candidate-must-contain-regular-files')
        for member in members:
            dest = candidate/member.name
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source:
                    dest.write_bytes(source.read())
                dest.chmod(member.mode & 0o777)


def identity(root):
    value = json.loads(invoke([sys.executable, '-B', str(Path(root)/'tools/run.py'), 'describe'], root))
    result = {k: value[k] for k in ('apiVersion', 'classes', 'bindingVersions')}
    config = json.loads((Path(root)/'agent-space.genet.json').read_text(encoding='utf-8')).get('team') or {}
    result['settingsSha256'] = hashlib.sha256(json.dumps(config.get('settings', {}), sort_keys=True).encode()).hexdigest()
    return result


def validate(t, root, row, directory, tree):
    candidate = directory/'candidate'
    # A generation has one worker. Interrupted preparation is retried using a
    # new private attempt, never sweeping another generation's files.
    if candidate.exists():
        candidate = directory/('candidate-' + str(t.now_ms()))
    candidate.mkdir()
    extract(t, root, tree, candidate)
    if identity(candidate) != identity(root):
        raise Conflict(['agent-space.genet.json#team'], 'Class/API/binding/settings changed; keep original work deployment')
    settings = (t.descriptor(root) or {}).get('team', {}).get('settings', {}).get('upgrade', {})
    commands = settings.get('regressionCommands')
    if commands is None:
        commands = ([[sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tools/tests', '-p', 'test_*.py']]
                    if (candidate/'tools/tests').is_dir() else [])
    if (not isinstance(commands, list) or len(commands) > 16
            or any(not isinstance(c, list) or not c or any(not isinstance(a, str) or not a for a in c) for c in commands)):
        raise Conflict(['agent-space.genet.json#team.settings.upgrade'], 'invalid-regression-commands')
    for command in commands:
        row['failedCommand'] = command[:12]
        invoke(command, candidate, timeout=600)
    row.pop('failedCommand', None)
    builder = t.builder_script(root)
    output = directory/('output-' + str(t.now_ms()))
    invoke([sys.executable, builder, 'build', str(candidate), '--output', str(output),
            '--require-no-post-commands', '--format', 'json'], candidate, timeout=600)
    invoke([sys.executable, builder, 'verify', str(output), '--artifacts-only', '--format', 'json'], candidate)
    identity(output)
    row.update(candidate=str(candidate), output=str(output), tree=tree)
    return builder


def receipt(t, root, release):
    from .template_version import fingerprint
    ident, _ = fingerprint(root)
    if release:
        t.write_json(t.state_dir(root, 'template-adoption.json'),
                     dict(schema='team-template-adoption/1', templateId=ident,
                          releaseVersion=release, verifiedAtMs=t.now_ms()))
    return ident


def install(t, root, row):
    spec = importlib.util.spec_from_file_location('team_upgrade_installer', str(Path(root)/'tools/install_remote.py'))
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    plan = {}
    for role in t.child_role_names(root):
        declared = t.role_machine(root, role)
        if declared is None:
            continue
        machine, here = t.machine_entry(declared)
        if not here:
            plan.setdefault(machine, []).append(role)
    original = t.descriptor(root) or {}
    for machine, roles in plan.items():
        members, digest = installer.install(Path(row['output']), Path(root), machine, roles, parallel=True)
        installer.write_members(Path(root), [dict(m, machineId=machine) for m in members])
        current = t.descriptor(root) or {}
        # Installation owns only member bindings. Do not commit another
        # writer's definition changes or treat them as a verified upgrade.
        if {k: v for k, v in original.items() if k != 'members'} != {k: v for k, v in current.items() if k != 'members'}:
            raise RuntimeError('source definition changed during installation; retain installed receipts and wait')
        changed = git(t, root, 'status', '--porcelain', '-z').decode().split('\0')
        if any(x and x[3:] != 'agent-space.genet.json' for x in changed):
            raise RuntimeError('source changed during installation; retain installed receipts and wait')
        if any(changed):
            git(t, root, 'add', '--', 'agent-space.genet.json')
            git(t, root, 'commit', '--only', '-q', '-m', 'upgrade: verified execution bindings', '--', 'agent-space.genet.json')
        # A later offline machine must not leave successful member writes as
        # an uncommitted source that prevents the durable operation resuming.
        row['head'] = t.git_text(root, 'rev-parse', 'HEAD')
    if plan:
        builder = t.builder_script(root)
        invoke([sys.executable, builder, 'build', root, '--require-no-post-commands', '--format', 'json'], root, timeout=600)
        invoke([sys.executable, builder, 'verify', root, '--format', 'json'], root)
    row['head'] = t.git_text(root, 'rev-parse', 'HEAD')
    return receipt(t, root, row.get('releaseVersion'))


def apply_source(t, root, row, platform, tree, builder):
    from .update_gate import gate
    with gate(root, exclusive=True):
        if (selection(t, root)[1] != row['target'] or not clean(t, root)
                or t.git_text(root, 'rev-parse', 'HEAD') != row['head']):
            raise SafePointBusy('newer-template-or-source-change')
        original = row['head']
        try:
            if row.get('mergeBaseMode') == 'reviewed':
                # Both histories remain intact. The explicit comparison base
                # is not fabricated ancestry; only the validated tree is used.
                applied = git(t, root, 'commit-tree', tree, '-p', original, '-p', platform,
                              '-m', 'upgrade: ' + row['target'] + '\n\nReviewed baseline: ' + row['mergeBase']).decode().strip()
                git(t, root, 'read-tree', '-m', '-u', original, tree)
                try:
                    git(t, root, 'update-ref', 'HEAD', applied, original)
                except t.ExpertError:
                    if (t.git_text(root, 'rev-parse', 'HEAD') == original
                            and t.git(root, 'diff', '--quiet', check=False).returncode == 0
                            and t.git_text(root, 'write-tree') == tree):
                        git(t, root, 'read-tree', '-m', '-u', tree, original)
                    raise
            else:
                git(t, root, 'merge', '--no-ff', '--no-edit', '-m', 'upgrade: ' + row['target'], platform)
            applied = t.git_text(root, 'rev-parse', 'HEAD')
            row['appliedCommit'] = applied
            if t.git_text(root, 'rev-parse', 'HEAD^{tree}') != tree:
                raise RuntimeError('applied tree differs from independently validated candidate')
            invoke([sys.executable, builder, 'build', root, '--require-no-post-commands', '--format', 'json'], root, timeout=600)
            invoke([sys.executable, builder, 'verify', root, '--format', 'json'], root)
            row.update(head=applied, sourceApplied=True)
            if not clean(t, root):
                raise SafePointBusy('source-changed-during-application; retain foreign edits')
        except SafePointBusy:
            raise
        except (RuntimeError, t.ExpertError, OSError, ValueError, subprocess.TimeoutExpired):
            # Restore only our own exact clean merge while the import lock
            # remains held. Never reset/stash a user's concurrent changes.
            applied = row.get('appliedCommit')
            if applied and applied != original and clean(t, root) and t.git_text(root, 'rev-parse', 'HEAD') == applied:
                try:
                    git(t, root, 'revert', '--no-edit', '-m', '1', applied)
                    row['rolledBackTo'] = t.git_text(root, 'rev-parse', 'HEAD')
                    invoke([sys.executable, builder, 'build', root, '--require-no-post-commands', '--format', 'json'], root, timeout=600)
                except (RuntimeError, t.ExpertError, OSError, subprocess.TimeoutExpired) as rollback_error:
                    row['rollbackError'] = str(rollback_error)[-1600:]
            raise


def worker(t, root, generation):
    row = t.read_json(str(location(t, root)), {}) or {}
    if row.get('generation') != generation:
        return row
    row['workerPid'] = os.getpid()
    directory = Path(t.state_dir(root, 'upgrade', generation))
    try:
        if not clean(t, root) or t.git_text(root, 'rev-parse', 'HEAD') != row['head']:
            return store(t, root, row, 'waiting-safe-point', reason='source-changed-before-validation')
        if row.get('sourceApplied'):
            if selection(t, root)[1] != row['target']:
                return store(t, root, row, 'waiting-safe-point', reason='newer-template-available')
            try:
                ident = install(t, root, row)
            except (RuntimeError, t.ExpertError, OSError, subprocess.TimeoutExpired) as error:
                return store(t, root, row, 'waiting-safe-point', reason='execution-install-pending',
                             installError=str(error)[-1600:])
            return store(t, root, row, 'adopted', reason='verified-source-and-execution', templateId=ident)
        platform, tree = merge_tree(t, root, row, directory)
        builder = validate(t, root, row, directory, tree)
        apply_source(t, root, row, platform, tree, builder)
        # Preserve the exact source adoption separately from the installed
        # daemon version. Explicit template overrides carry no release claim.
        if not any(t.env_get(k) for k in ('TEAM_TEMPLATE', 'EXPERT_TEAM_TEMPLATE', 'EXPERT_TEMPLATE')):
            row['releaseVersion'] = (t.genet('context').get('daemon') or {}).get('version')
        try:
            ident = install(t, root, row)
        except (RuntimeError, t.ExpertError, OSError, subprocess.TimeoutExpired) as error:
            return store(t, root, row, 'waiting-safe-point', reason='execution-install-pending',
                         installError=str(error)[-1600:], sourceApplied=True)
        return store(t, root, row, 'adopted', reason='verified-source-and-execution', templateId=ident)
    except Conflict as error:
        return store(t, root, row, 'conflict', reason=str(error), conflictFiles=error.files)
    except SafePointBusy as error:
        return store(t, root, row, 'waiting-safe-point', reason=str(error))
    except (RuntimeError, t.ExpertError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        return store(t, root, row, 'test-failure', reason=str(error)[-1600:])
    finally:
        current = t.read_json(str(location(t, root)), {}) or {}
        if current.get('generation') == generation and current.get('workerPid') == os.getpid():
            current.pop('workerPid', None)
            t.write_json(str(location(t, root)), current)


def command(t, args):
    root = t.find_root()
    if args.status:
        value = t.read_json(str(location(t, root)), {}) or {'status': 'waiting-safe-point', 'reason': 'not-yet-checked'}
    elif args.worker:
        value = worker(t, root, args.worker)
    else:
        value = schedule(t, root, args.base)
    print(json.dumps(value, ensure_ascii=False))
