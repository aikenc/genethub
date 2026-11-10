"""Team-owned platform feedback. File operations only; no Session delivery or wake."""
import hashlib
import json
import os
from pathlib import Path
import re
from .api import TeamConfigurationError


SCHEMA = 'team-platform-feedback/1'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def template_version():
    """Identity of the actual loaded builtin package, independent of project Classes."""
    root = Path(__file__).resolve().parent
    h = hashlib.sha256()
    for path in sorted(root.rglob('*.py')):
        h.update(path.relative_to(root).as_posix().encode('utf-8') + b'\0')
        h.update(path.read_bytes() + b'\0')
    return 'sha256:' + h.hexdigest()


def text(value, label, limit=4096):
    value = str(value).strip()
    if not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise TeamConfigurationError('%s must be nonempty, bounded single-line text' % label)
    return value


def read(path):
    if path.stat().st_size > 2 * 1024 * 1024:
        raise TeamConfigurationError('feedback record exceeds bounded read; preserve it for inspection')
    value = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or value.get('schema') != SCHEMA
            or value.get('id') != path.stem or not isinstance(value.get('fingerprint'), str)
            or value.get('kind') not in ('template', 'kernel', 'skill')
            or not isinstance(value.get('title'), str)
            or value.get('state') not in ('open', 'fixed', 'recurred', 'not-fixed')
            or not isinstance(value.get('occurrences'), list)
            or not isinstance(value.get('verifications', []), list)
            or not all(isinstance(row, dict) for row in value['occurrences'])
            or not all(isinstance(row, dict) for row in value.get('verifications', []))):
        raise TeamConfigurationError('invalid feedback record; preserve it for inspection: ' + path.name)
    return value


def location(root, ident):
    if not re.fullmatch(r'pf-[a-f0-9]{24}', ident):
        raise TeamConfigurationError('invalid platform feedback id')
    return Path(root) / 'datas' / 'platform-feedback' / (ident + '.json')


def operation(args, payload):
    # A new observation uses a new request/evidence; an unknown retry keeps the original identity.
    caller = os.environ.get('GENEHUB_SESSION_ID', 'manual')
    ident = text(args.request_id, 'request id', 128) if args.request_id else 'auto.' + digest([caller, payload])
    return ident, digest(payload)


def previous(rows, ident, intent):
    for row in rows:
        if not isinstance(row, dict):
            raise TeamConfigurationError('invalid feedback history; preserve the original record')
        if row.get('requestId') == ident:
            if row.get('intentDigest') != intent:
                raise TeamConfigurationError('feedback request id already belongs to different content')
            return True
    return False


def summary(value, status):
    return dict(status=status, id=value['id'], fingerprint=value['fingerprint'], kind=value['kind'],
                title=value['title'], state=value['state'], occurrences=len(value['occurrences']),
                verifiedIn=value.get('verifiedIn'), path='datas/platform-feedback/' + value['id'] + '.json')


def add(t, root, args):
    title = text(args.title, 'title', 300)
    evidence = [text(item, 'evidence') for item in args.evidence]
    reference = text(args.ref, 'reference', 128) if args.ref else None
    fingerprint = text(args.fingerprint, 'fingerprint', 512) if args.fingerprint else ':'.join(
        [args.kind, reference or 'unclassified', title])
    fingerprint = ' '.join(fingerprint.split()).casefold()
    ident = 'pf-' + digest(fingerprint)[:24]
    path = location(root, ident)
    payload = dict(kind=args.kind, title=title, evidence=evidence, ref=reference,
                   fingerprint=fingerprint, workaround=args.workaround)
    request_id, intent = operation(args, payload)
    with t.inbox_lock(root, 'platform-feedback-' + ident, purpose='平台反馈记录'):
        value = read(path) if path.exists() else None
        if value and value['fingerprint'] != fingerprint:
            raise TeamConfigurationError('feedback fingerprint collision; original record preserved')
        if value and previous(value['occurrences'], request_id, intent):
            return summary(value, 'already-recorded')
        fresh = value is None
        value = value or dict(schema=SCHEMA, id=ident, fingerprint=fingerprint, kind=args.kind,
                              title=title, occurrences=[], verifications=[], state='open', verifiedIn=None)
        version = template_version()
        value['occurrences'].append(dict(requestId=request_id, intentDigest=intent, atMs=t.now_ms(),
                                         evidence=evidence, ref=reference, kind=args.kind,
                                         title=title, templateVersion=version))
        if args.workaround is not None:
            value['workaround'] = text(args.workaround, 'workaround')
        value['templateVersion'] = version
        if value['state'] == 'fixed':
            value['state'] = 'recurred'
        t.write_json(str(path), value)
        return summary(value, 'created' if fresh else 'updated')


def verify(t, root, args):
    path = location(root, args.id)
    evidence = [text(item, 'evidence') for item in args.evidence]
    version = template_version()
    adopted = text(args.version, 'adopted version', 256) if args.version else None
    payload = dict(result=args.result, evidence=evidence, templateVersion=version, version=adopted)
    request_id, intent = operation(args, payload)
    with t.inbox_lock(root, 'platform-feedback-' + args.id, purpose='平台反馈复验'):
        value = read(path)
        rows = value.setdefault('verifications', [])
        if previous(rows, request_id, intent):
            return summary(value, 'already-recorded')
        verification = dict(requestId=request_id, intentDigest=intent, atMs=t.now_ms(),
                            result=args.result, evidence=evidence, templateVersion=version, version=adopted)
        rows.append(verification)
        value['state'] = args.result
        value['verifiedIn'] = verification
        t.write_json(str(path), value)
        return summary(value, 'verified')


def register(sub):
    parser = sub.add_parser('feedback', help='record and verify team-owned platform feedback without waking a Session')
    commands = parser.add_subparsers(dest='feedback_command', required=True)
    add_parser = commands.add_parser('add')
    add_parser.add_argument('--kind', required=True, choices=['template', 'kernel', 'skill'])
    add_parser.add_argument('--title', required=True)
    add_parser.add_argument('--evidence', required=True, action='append')
    add_parser.add_argument('--ref')
    add_parser.add_argument('--fingerprint', help='stable cause/object key; defaults to kind:ref:title')
    add_parser.add_argument('--workaround')
    add_parser.add_argument('--request-id', help='stable observation identity; retain it and the exact body when retrying')
    commands.add_parser('ls').add_argument('--open', action='store_true')
    verification = commands.add_parser('verify')
    verification.add_argument('id')
    verification.add_argument('--result', required=True, choices=['fixed', 'recurred', 'not-fixed'])
    verification.add_argument('--evidence', required=True, action='append')
    verification.add_argument('--version', help='actual adopted kernel/release version; loaded template identity is recorded automatically')
    verification.add_argument('--request-id', help='stable verification identity; retain it on unknown retries')


def command(t, args):
    root = t.find_root()
    try:
        if args.feedback_command == 'add':
            result = add(t, root, args)
        elif args.feedback_command == 'verify':
            result = verify(t, root, args)
        else:
            rows = [read(p) for p in sorted((Path(root) / 'datas/platform-feedback').glob('pf-*.json'))]
            result = [summary(row, 'recorded') for row in rows if not args.open or row['state'] != 'fixed']
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError) as error:
        raise t.ExpertError('平台反馈读写失败: ' + str(error), '原记录保留，没有发送消息或唤醒会话',
                            '核对原编号和证据；修复存储后用相同 request-id 与内容重试') from error
