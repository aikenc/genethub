"""Bounded live quality observations and durable redline occurrences.

The timer is the producer. Public offline projection never writes Team state.
Fresh complete native observations close an incident automatically; goal acceptance is separate.
"""
import hashlib
from pathlib import Path
from .quality_score import canonical, number, score
from . import quality

HOUR = 3600000
ROUTES = {'R1':'platform-template','R2':'team','R3':'platform-template',
          'R4':'unknown','R5':'platform-template','R6':'unknown'}


def identity(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()[:24]


def project(facts):
    # Native occurrences decide this window; durable history is evidence,
    # never an additional physical violation.
    facts=dict(facts)
    if 'redlineLifecycle' in facts:
        facts['redlineLifecycle']=dict(facts['redlineLifecycle'],open=[])
    card = score(facts)
    now = facts['window']['endAtMs']
    basis = card.get('streakCompatibilityKey', card['model'])
    red = []
    for rule, verdict in card['redLines'].items():
        for instance in verdict.get('instances', []):
            red.append(dict(instance, workItemId=instance.get('workItemId',instance.get('taskId','team-active-goals')), rule=rule,
                            attribution=instance.get('attribution') or {'component':ROUTES[rule],'rootCauseConfirmed':False}, measurementVersion=basis,
                            officialHour=card['officialCapture'], sourceWindowEndMs=now))
    warnings = []
    def warn(rule, item, since, duration, resolved=None):
        if number(since) and since+duration <= now and not number(resolved):
            warnings.append({'id':identity([rule,item['id'],since]),'rule':rule,
                             'workItemId':item['id'],'sinceAtMs':since,
                             'detail':rule+' obligation remains open before its redline threshold'})
    for item in facts.get('workItems', []):
        if item.get('hasReceipt') is False and not number(item.get('withdrawnAtMs')):
            warn('R1',item,item.get('dispatchAtMs'),300000,item.get('confirmedAtMs'))
        if not item.get('standing'):
            for idle in item.get('idlePeriods', []):
                if idle.get('observedThroughAtMs',0) >= now-125000:
                    warn('R2',item,idle.get('startAtMs'),1800000,idle.get('resolvedAtMs'))
        if item.get('deliveryCoverageKnown') is True and not any(
                x.get('recipient')==item.get('requester') for x in item.get('deliveryBounds',[])):
            warn('R3',item,item.get('conclusionAtMs'),180000,item.get('deliveredAtMs'))
        if item.get('resourceRequired') and item.get('resourceHeld') is True:
            warn('R5',item,item.get('conclusionAtMs'),300000,item.get('releasedAtMs'))
    for stall in facts.get('stalls', []):
        if stall.get('endAtMs',0) >= now:
            warn('R4',{'id':stall['taskId']},stall.get('startAtMs'),480000)
    return {'schema':'team-quality-live-alerts/1','asOfMs':facts['capturedAtMs'],
            'redLines':red,'warnings':warnings,
            'windowEndMs':now,
            'nativeFactsSha256':hashlib.sha256(canonical(facts).encode()).hexdigest(),
            'ruleCoverage':{rule:(v['coverageKnown'] and (rule != 'R6' or facts.get('taskTreesSourceComplete') is True and all(x['state']!='unknown' for x in card.get('taskParallelism') or []))) for rule,v in card['redLines'].items()},
            'unknown':[{'rule':rule} for rule,v in card['redLines'].items() if v['triggered'] is None]
                      +[dict(issue,rule='source-evidence') for issue in facts.get('issues',[])]}


def same_occurrence(row, signal):
    return (row['rule']==signal['rule'] and row['workItemId']==signal['workItemId']
            and row.get('reason')==signal.get('reason')
            and (row['rule']=='R6' or row.get('dueAtMs')==signal.get('dueAtMs')))


def notification(row):
    correction = (row.get('corrections') or [])[-1:]
    component = correction[0]['attribution'] if correction else (row.get('attribution') or {}).get('component','unknown')
    return {'target':'team' if component=='team' else 'platform-development',
            'component':component, 'basis':'correction-note/1' if correction else 'automatic-attribution/1'}


def advance(state, sample):
    """Shared production transition; supports a read-only chronological replay."""
    now = sample['asOfMs']
    state = state or {'schema':'team-quality-redline-state/1','startedAtMs':now,'incidents':{},'hours':{}}
    if state.get('schema')!='team-quality-redline-state/1':raise ValueError('unknown redline state')
    if now < state.get('asOfMs',now):raise ValueError('redline samples must be chronological')
    state['asOfMs'] = now
    new = []
    for signal in sample['redLines']:
        rule = signal['rule'];basis = signal['measurementVersion']
        key = identity([rule,signal['workItemId'],signal.get('reason'),
                        basis,signal.get('dueAtMs') if rule!='R6' else 'parallelism'])
        row=next((x for x in state['incidents'].values() if x['status']=='open' and same_occurrence(x,signal)),None)
        closed=max((x for x in state['incidents'].values() if x['status']=='closed' and same_occurrence(x,signal)),
                   key=lambda x:x['closedAtMs'],default=None)
        if row is None and closed:
            if (signal.get('officialHour') and signal['sourceWindowEndMs']<=closed['closedAtMs']
                    or number(signal.get('resolvedAtMs')) and signal['resolvedAtMs']<=closed['closedAtMs']):
                continue
            key=identity([key,closed['closedAtMs']])
        if row is None:
            row = dict(signal,id=key,firstSeenAtMs=now,status='open')
            if closed:row['previousClosedAtMs']=closed['closedAtMs']
            state['incidents'][key] = row;new.append(key)
        else:key=row['id']
        row['lastSeenAtMs'] = now
        if number(signal.get('resolvedAtMs')):
            row['symptomResolvedAtMs'] = max(row.get('symptomResolvedAtMs') or 0,signal['resolvedAtMs'])
        row['notification'] = notification(row)
    # Historical hourly signals feed audit only. Closure needs the
    # current complete native rule observation, never absence from a failed read.
    current = [x for x in sample['redLines'] if x.get('sourceWindowEndMs') == sample.get('windowEndMs')]
    for row in state['incidents'].values():
        if row['status'] != 'open' or (sample.get('ruleCoverage') or {}).get(row['rule']) is not True:
            continue
        matching = [x for x in current if same_occurrence(row,x)]
        if any(not number(x.get('resolvedAtMs')) or x['resolvedAtMs'] > now for x in matching):
            continue
        closed_at = max([x['resolvedAtMs'] for x in matching], default=now)
        row.update(status='closed', closedAtMs=closed_at,
                   resolution={'basis':'native-hourly-facts/2', 'observedAtMs':now,
                               'nativeFactsSha256':sample.get('nativeFactsSha256'),
                               'ruleCoverageKnown':True})
    return state,new,[]


def replay(value):
    if value.get('schema')=='team-quality-facts/1':return project(value)
    if value.get('schema')!='team-quality-alert-samples/1':raise ValueError('unknown alert replay schema')
    state=None;steps=[]
    for facts in value['samples']:
        sample=project(facts);state,new,escalated=advance(state,sample)
        steps.append({'asOfMs':sample['asOfMs'],'new':new,'escalated':escalated,'warnings':sample['warnings'],'unknown':sample['unknown']})
    return {'schema':'team-quality-alert-replay/1','officialCapture':False,'state':state,'steps':steps}


def current(root):
    path=Path(root)/'.genethub/team/quality/live-alerts.json'
    value=quality.read(path)
    return value or {'schema':'team-quality-live-alerts/1','asOfMs':None,'redLines':[],
                     'warnings':[],'unknown':[{'rule':'live-alerts-absent'}]}


def _card_signals(root, started, now):
    """Only observed native hours since activation; old debt stays in live facts."""
    store=Path(root)/'.genethub/team/quality';latest={}
    for path in sorted((store/'cards').glob('*.json'))[-2048:]:
        card=quality.read(path);end=card.get('window',{}).get('endAtMs')
        if not number(end) or end<started//HOUR*HOUR or end>now or not card.get('officialCapture'):continue
        if end not in latest or card['capturedAtMs']>latest[end]['capturedAtMs']:latest[end]=card
    signals=[]
    for end,card in sorted(latest.items())[-48:]:
        basis=card.get('streakCompatibilityKey',card['model'])
        for rule,v in card['redLines'].items():
            for item in v.get('instances',[]):
                if item.get('incidentId'):continue  # Carried debt is not a new physical occurrence.
                signals.append(dict(item,workItemId=item.get('workItemId',item.get('taskId','team-active-goals')),rule=rule,
                                    attribution=item.get('attribution') or {'component':ROUTES[rule],'rootCauseConfirmed':False},measurementVersion=basis,
                                    officialHour=True,sourceWindowEndMs=end,cardEvidence=card['factsSha256']))
    return signals


def notify_team(team, root, row, facts):
    """Platform redlines are already delivered in live-alerts; wake only Team work."""
    route = notification(row);row['notification']=route
    if route['target'] != 'team':return
    ident=row['id']
    context=canonical({k:row.get(k) for k in ('id','rule','workItemId','attribution','corrections','evidence')}).strip()
    if not row.get('noteId'):
        note,_=team.add_note(root,{'kind':'redline','from':'system:quality','text':'团队工作质量红线 '+row['rule'],
            'quote':'按自动归因处理本队问题，下一张卡看结果；判断有误时可补更正备注。',
            'context':context,'ref':row['evidence']['path']},'quality-redline',ident,'new')
        row['noteId']=note
    work=next((x for x in facts.get('workItems',[]) if x['id']==row['workItemId']),{})
    task_id=work.get('taskId') or row['workItemId']
    task=quality.read(Path(root)/'.genethub/team/tasks'/(task_id+'.json'),{})
    owner=(task.get('owner') or {}).get('sessionId')
    if owner and team.SESSION_ID.fullmatch(owner) and row.get('ownerNotified') != owner:
        team.deliver_or_notice(root,owner,'report','system:quality',
            '团队工作质量红线 '+row['rule']+'\n'+context,ref=row['evidence']['path'],
            machine=(task.get('owner') or {}).get('machine'),
            delivery_id='quality-redline.'+ident+'.'+owner)
        row['ownerNotified']=owner


def tick(team, root):
    store=Path(root)/'.genethub/team/quality'
    with team.inbox_lock(root,'quality-live',purpose='实时红线'):
        now=team.now_ms();state=quality.read(store/'redline-state.json')
        facts=quality.capture(team,root,now,now,budget_seconds=8,live=True)
        facts['captureKind']='live-diagnostic'
        sample=project(facts)
        sample['redLines']+=_card_signals(root,(state or {}).get('startedAtMs',now),now)
        state,new,escalated=advance(state,sample)
        team.write_json(str(store/'live-facts.json'),facts)
        for ident,row in state['incidents'].items():
            evidence=store/'incidents'/(ident+'.json')
            if not evidence.exists():team.write_json(str(evidence),{'incident':row,'facts':facts})
            row['evidence']={'path':str(evidence.relative_to(Path(root))),'dueAtMs':row.get('dueAtMs'),
                             'firstSeenAtMs':row['firstSeenAtMs'],'measurementVersion':row['measurementVersion']}
            if row['status'] == 'closed':
                archive=store/'incidents'/(ident+'.closed.json')
                if not archive.exists():team.write_json(str(archive),{'incident':row,'facts':facts})
                if not row.get('closureRecorded'):
                    team.quality_events.emit(team,root,'redline-closed',ident,incidentId=ident,
                                            rule=row['rule'],closedAtMs=row['closedAtMs'],resolution=row.get('resolution'))
                    row['closureRecorded']=True
            if row.get('symptomResolvedAtMs') is not None and not row.get('resolutionRecorded'):
                team.quality_events.emit(team,root,'redline-symptom-resolved',ident,incidentId=ident,rule=row['rule'],
                    resolvedAtMs=row['symptomResolvedAtMs'],repairAdoptionVerified=False)
                row['resolutionRecorded']=True
            if row['status']!='open':continue
            if not row.get('openedRecorded'):
                if not row.get('noteId'):  # Legacy Team notes already emitted this event.
                    team.quality_events.emit(team,root,'redline-opened',ident,rule=row['rule'],incidentId=ident,
                                             workItemId=row['workItemId'],attribution=row['attribution'],evidence=row['evidence'])
                row['openedRecorded']=True
            notify_team(team,root,row,facts)
        team.write_json(str(store/'redline-state.json'),state)
        # Current obligations plus unreadable unresolved instances remain live;
        # the immutable hourly cards never receive historical closure debt.
        sample['redLines']=[dict(row) for row in state['incidents'].values() if row['status']=='open']
        sample['measurementEpoch']=None
        sample['lifecyclePolicy']='native-hourly-facts/2'
        for warning in sample['warnings']:
            warning['id']=identity([warning['rule'],warning['workItemId'],warning['sinceAtMs']])
        team.write_json(str(store/'live-alerts.json'),sample)
        return sample


def triage(team, root, args):
    store=Path(root)/'.genethub/team/quality'
    with team.inbox_lock(root,'quality-live',purpose='红线归因'):
        state=quality.read(store/'redline-state.json');row=state['incidents'][args.incident]
        evidence=str(args.evidence).strip()
        if not evidence or len(evidence)>2048 or '\n' in evidence:raise ValueError('bounded correction evidence required')
        value={'attribution':args.attribution,'evidence':evidence}
        notes=row.setdefault('corrections',[])
        if notes and all(notes[-1].get(k)==v for k,v in value.items()):return row
        notes.append(dict(value,atMs=team.now_ms(),sessionId=__import__('os').environ.get('GENEHUB_SESSION_ID')))
        row['notification']=notification(row)
        team.write_json(str(store/'redline-state.json'),state)
        team.quality_events.emit(team,root,'redline-attribution-corrected',args.incident+':'+str(len(notes)),
                                 incidentId=args.incident,**notes[-1])
        return row


def failed(team, root, error):
    # An unavailable read cannot erase an already observed open redline.
    value=current(root)
    value['attemptedAtMs']=team.now_ms()
    value['unknown']=[x for x in value['unknown'] if x.get('rule')!='live-capture']+[
        {'rule':'live-capture','error':type(error).__name__}]
    team.write_json(str(Path(root)/'.genethub/team/quality/live-alerts.json'),value)


def briefing(root):
    value=current(root)
    return ['', '## 未关闭红线（按原生事实自动复核归档；未知保持未知）',
            '观测时间：'+str(value.get('asOfMs')),
            *['- '+canonical({k:x.get(k) for k in ('id','rule','workItemId','attribution','evidence','notification','corrections')}).strip()
              for x in value['redLines']],
            '未知：'+canonical(value['unknown']).strip()]
