"""Identity of the builtin package actually executing this Team command.

An installed daemon version or a platform baseline branch is not adoption.
The upgrader may attach a release label only to these exact runtime bytes.
"""
import hashlib
import json
import re
from pathlib import Path


def fingerprint(root):
    root = Path(root)
    files = [root/'tools/run.py']
    for prefix in ('tools/genet_builtin', 'skills/genet_builtin'):
        base = root/prefix
        if base.is_symlink() or not base.is_dir():raise ValueError('builtin package unavailable')
        for p in base.rglob('*'):
            if '__pycache__' in p.parts or p.suffix in ('.pyc','.pyo'):continue
            if p.is_symlink():raise ValueError('builtin package alias')
            if p.is_file():files.append(p)
    if len(files)>10000:raise ValueError('builtin package file bound exceeded')
    digest=hashlib.sha256();size=0
    for path in sorted(files):
        if path.is_symlink() or not path.is_file():raise ValueError('builtin package must be regular')
        size+=path.stat().st_size
        if size>64*1024*1024:raise ValueError('builtin package byte bound exceeded')
        payload=path.read_bytes()
        digest.update(path.relative_to(root).as_posix().encode()+b'\0'+payload+b'\0')
    return 'sha256:'+digest.hexdigest(),len(files)


def capture(root, now):
    try:
        ident,count=fingerprint(root)
    except (OSError, ValueError) as error:
        return {'schema':'team-running-template-version/1','id':None,'releaseVersion':None,
                'status':'unknown','error':type(error).__name__}
    value={'schema':'team-running-template-version/1','id':ident,'fileCount':count,
           'releaseVersion':None,'status':'content-only'}
    receipt=Path(root)/'.genethub/team/template-adoption.json'
    if not receipt.exists():return value
    try:
        if receipt.is_symlink() or receipt.stat().st_size>8192:raise ValueError('invalid adoption receipt')
        proof=json.loads(receipt.read_text(encoding='utf-8'))
        if (proof.get('schema')!='team-template-adoption/1' or proof.get('templateId')!=ident
                or not isinstance(proof.get('releaseVersion'),str)
                or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,64})?',proof['releaseVersion'])
                or type(proof.get('verifiedAtMs')) not in (int,float)
                or not 0<proof['verifiedAtMs']<=now):
            raise ValueError('adoption receipt does not prove these bytes')
        value.update(releaseVersion=proof['releaseVersion'],status='verified-adoption',
                     verifiedAtMs=proof['verifiedAtMs'])
    except (OSError, ValueError, TypeError, AttributeError):
        value['status']='unverified-receipt'
    return value
