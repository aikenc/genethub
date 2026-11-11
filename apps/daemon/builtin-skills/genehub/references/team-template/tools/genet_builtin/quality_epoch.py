"""Versioned measurement policy; old frozen facts remain unchanged."""
from pathlib import Path

POLICY = 'verified-repair-adoption/1'


def context(root, end):
    from .quality import read
    state = read(Path(root)/'.genethub/team/quality/redline-state.json') or {}
    epochs = [x for x in state.get('measurementEpochs', []) if x['atMs'] <= end]
    return {'schema': 'team-quality-redline-lifecycle/1', 'policy': POLICY,
            'epoch': max(epochs, key=lambda x:x['atMs']) if epochs else None,
            'open': [dict(x) for x in state.get('incidents', {}).values()
                     if x['firstSeenAtMs'] < end and
                     (x.get('closedAtMs') is None or x['closedAtMs'] >= end)]}


def validate(value):
    if not isinstance(value, dict) or value.get('schema') != 'team-quality-redline-lifecycle/1' or value.get('policy') != POLICY:
        raise ValueError('unsupported redline lifecycle policy')
    if not isinstance(value.get('open'), list):raise ValueError('redline lifecycle requires explicit open instances')
    return value


def attach(card, value):
    validate(value)
    epoch = value.get('epoch')
    version = card.get('measurementVersion', card['model'])+'+'+POLICY
    card['measurementVersion'] = version
    card['streakCompatibilityKey'] = version+':epoch:'+(epoch['id'] if epoch else 'initial')
    card['redlineLifecycle'] = value
    card['disqualified'] = any(x['triggered'] is True for x in card['redLines'].values())
    card['qualificationState'] = ('redline' if card['disqualified'] else
                                  'remeasuring' if epoch and not card['formal'] else 'measured')
    if epoch and not card['formal']:
        card['notFormalReason'] = '重新测量中：修复采用后样本/覆盖不足；历史卡保留'
