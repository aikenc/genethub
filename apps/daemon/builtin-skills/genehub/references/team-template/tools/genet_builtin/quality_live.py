"""Bounded live quality observations and durable redline occurrences.

The timer is the producer. Public offline projection never writes Team state.
A symptom disappearing does not prove a repair was adopted or close the goal.
"""
import hashlib
from pathlib import Path
from types import SimpleNamespace
from .quality_score import canonical, number, score
from . import quality

HOUR = 3600000
ROUTES = {'R1':'platform-template','R2':'team','R3':'platform-template',
          'R4':'unknown','R5':'platform-template','R6':'unknown'}


def identity(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()[:24]


def project(facts):
    # Detection uses current obligations. Durable unresolved episodes are a
    # separate scoring policy, not evidence that the symptom still exists.
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
            'unknown':[{'rule':rule} for rule,v in card['redLines'].items() if v['triggered'] is None]
                      +[dict(issue,rule='source-evidence') for issue in facts.get('issues',[])]}


def advance(state, sample):
    """Shared production transition; supports a read-only chronological replay."""
    now = sample['asOfMs']
    state = state or {'schema':'team-quality-redline-state/1','startedAtMs':now,'incidents':{},'hours':{}}
    if state.get('schema')!='team-quality-redline-state/1':raise ValueError('unknown redline state')
    if now < state.get('asOfMs',now):raise ValueError('redline samples must be chronological')
    state['asOfMs'] = now
    new, escalated = [], []
    for signal in sample['redLines']:
        rule = signal['rule'];basis = signal['measurementVersion']
        key = identity([rule,signal['workItemId'],signal.get('reason'),
                        basis,signal.get('dueAtMs') if rule!='R6' else 'parallelism'])
        def same(row):
            return (row['rule']==rule and row['workItemId']==signal['workItemId']
                    and row.get('reason')==signal.get('reason')
                    and (rule=='R6' or row.get('dueAtMs')==signal.get('dueAtMs')))
        row=next((x for x in state['incidents'].values() if x['status']=='open' and same(x)),None)
        closed=max((x for x in state['incidents'].values() if x['status']=='closed' and same(x)),
                   key=lambda x:x['closedAtMs'],default=None)
        if row is None and closed:
            if (signal.get('officialHour') and signal['sourceWindowEndMs']<=closed['closedAtMs']
                    or number(signal.get('resolvedAtMs')) and signal['resolvedAtMs']<=closed['closedAtMs']):
                continue
            key=identity([key,closed['closedAtMs']])
        if row is None:
            row = dict(signal,id=key,firstSeenAtMs=now,triageDueAtMs=now+900000,status='open')
            if closed:row['previousClosedAtMs']=closed['closedAtMs']
            state['incidents'][key] = row;new.append(key)
        else:key=row['id']
        row['lastSeenAtMs'] = now
        if number(signal.get('resolvedAtMs')):
            row['symptomResolvedAtMs'] = max(row.get('symptomResolvedAtMs') or 0,signal['resolvedAtMs'])
        if signal.get('officialHour'):
            hour = signal['sourceWindowEndMs'];hour_key=rule+':'+basis
            hours = state['hours'].setdefault(hour_key,[])
            if hour not in hours:hours.append(hour);hours.sort();hours[:]=hours[-48:]
            if hour-HOUR in hours and hour-HOUR>row.get('previousClosedAtMs',0) and not row.get('platformEscalation'):
                row['platformEscalation'] = 'consecutive-hours';escalated.append(key)
    for key,row in state['incidents'].items():
        if (row['status']=='open' and (row.get('triage') or {}).get('attribution','unknown')=='unknown'
                and now>=row['triageDueAtMs'] and not row.get('platformEscalation')):
            row['platformEscalation']='triage-timeout';escalated.append(key)
    return state,new,escalated


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


def platform_feedback(team, root, row):
    if not row.get('platformEscalation') or row.get('feedbackId'):
        return
    from . import feedback
    ident=row['id']
    result=feedback.add(team,root,SimpleNamespace(kind='template',title='红线自动升级：'+row['rule'],
        evidence=[row['evidence']['path']],ref=ident,fingerprint='quality-redline:'+ident,
        workaround='红线已升级平台排查；具体根因以实例归因和原生证据为准',
        request_id='redline-escalation.'+ident))
    row['feedbackId']=result['id']
    # One urgent redline note per episode; feedback is the platform's consumer.
    # Do not generate another Team wake merely to repeat an escalation.
    team.quality_events.emit(team,root,'redline-escalated',ident,rule=row['rule'],incidentId=ident,
                             reason=row['platformEscalation'],feedbackId=result['id'])


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
            if row.get('symptomResolvedAtMs') is not None and not row.get('resolutionRecorded'):
                team.quality_events.emit(team,root,'redline-symptom-resolved',ident,incidentId=ident,rule=row['rule'],
                    resolvedAtMs=row['symptomResolvedAtMs'],repairAdoptionVerified=False)
                row['resolutionRecorded']=True
            if row['status']!='open':continue
            if not row.get('noteId'):
                context=canonical({k:row.get(k) for k in ('id','rule','workItemId','attribution','evidence','triageDueAtMs')}).strip()
                note,_=team.add_note(root,{'kind':'redline','from':'system:quality','text':'团队工作质量红线 '+row['rule'],
                    'quote':row['rule']+'：15分钟内先判归因，平台原因留反馈，团队原因自主修正并复核。',
                    'context':context,'ref':row['evidence']['path']},'quality-redline',ident,'new')
                row['noteId']=note
                team.quality_events.emit(team,root,'redline-opened',ident,rule=row['rule'],incidentId=ident,
                                         workItemId=row['workItemId'],attribution=row['attribution'],evidence=row['evidence'])
            platform_feedback(team,root,row)
        team.write_json(str(store/'redline-state.json'),state)
        # Durable episodes survive an hour boundary or a disappearing symptom.
        # Explicit repair/adoption closure is a separate operation, never inferred
        # from baseline refresh or an unreadable Session.
        sample['redLines']=[dict(row) for row in state['incidents'].values() if row['status']=='open']
        sample['measurementEpoch']=next(iter(reversed(state.get('measurementEpochs',[]))),None)
        for warning in sample['warnings']:
            warning['id']=identity([warning['rule'],warning['workItemId'],warning['sinceAtMs']])
        team.write_json(str(store/'live-alerts.json'),sample)
        return sample


def triage(team, root, args):
    store=Path(root)/'.genethub/team/quality'
    with team.inbox_lock(root,'quality-live',purpose='红线归因'):
        state=quality.read(store/'redline-state.json');row=state['incidents'][args.incident]
        evidence=str(args.evidence).strip()
        if not evidence or len(evidence)>2048 or '\n' in evidence:raise ValueError('bounded triage evidence required')
        value={'attribution':args.attribution,'evidence':evidence}
        old=row.get('triage')
        if old and any(old.get(k)!=v for k,v in value.items()):raise ValueError('triage already recorded; preserve its original evidence')
        row['triage']=old or dict(value,atMs=team.now_ms(),sessionId=__import__('os').environ.get('GENEHUB_SESSION_ID'))
        if args.attribution in ('platform-template','kernel','provider'):
            row.setdefault('platformEscalation','triaged-platform')
            platform_feedback(team,root,row)
        team.write_json(str(store/'redline-state.json'),state)
        team.quality_events.emit(team,root,'redline-triaged',args.incident,incidentId=args.incident,**row['triage'])
        return row


def failed(team, root, error):
    # An unavailable read cannot erase an already observed open redline.
    value=current(root)
    value['attemptedAtMs']=team.now_ms()
    value['unknown']=[x for x in value['unknown'] if x.get('rule')!='live-capture']+[
        {'rule':'live-capture','error':type(error).__name__}]
    team.write_json(str(Path(root)/'.genethub/team/quality/live-alerts.json'),value)


def _evidence(root, name):
    path=Path(name)
    if path.is_absolute() or '..' in path.parts:raise ValueError('evidence must be a Team-relative regular file')
    root=Path(root).resolve();path=root/path
    if path.is_symlink() or not path.is_file() or root not in path.resolve().parents or not 0<path.stat().st_size<=131072:
        raise ValueError('bounded regular repair/adoption evidence required')
    return {'path':str(path.relative_to(root)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def resolve(team, root, args):
    """Explicit Team verification; never called automatically by an upgrade."""
    import os
    actor=os.environ.get('GENEHUB_SESSION_ID','')
    if not team.SESSION_ID.fullmatch(actor):raise ValueError('native Agent session required for repair verification')
    repair=_evidence(root,args.repair_evidence);adoption=_evidence(root,args.adoption_evidence)
    store=Path(root)/'.genethub/team/quality'
    with team.inbox_lock(root,'quality-live',purpose='红线修复采用复验'):
        state=quality.read(store/'redline-state.json');row=state['incidents'][args.incident]
        if row['status']=='closed':
            if row['resolution']['repair']!=repair or row['resolution']['adoption']!=adoption:
                raise ValueError('closed incident evidence is immutable')
            return row
        now=team.now_ms()
        facts=quality.capture(team,root,now,now,budget_seconds=100)
        sample=project(facts)
        if facts.get('issues') or any(x['rule']==row['rule'] for x in sample['unknown']):
            raise ValueError('unknown native evidence cannot close an incident')
        matching=[x for x in sample['redLines'] if x['rule']==row['rule']
                  and x['workItemId']==row['workItemId'] and x.get('reason')==row.get('reason')]
        if any(not number(x.get('resolvedAtMs')) or x['resolvedAtMs']>now for x in matching):
            raise ValueError('native obligation remains open after the claimed repair')
        closed_at=team.now_ms()
        proof=store/'resolutions'/(args.incident+'-facts.json')
        team.write_json(str(proof),facts)
        row['status']='closed';row['closedAtMs']=closed_at
        row['resolution']={'repair':repair,'adoption':adoption,'sessionId':actor,
            'nativeFacts':str(proof.relative_to(Path(root))),
            'nativeFactsSha256':hashlib.sha256(canonical(facts).encode()).hexdigest(),
            'observedAtMs':now,'versions':facts['versions']}
        epoch=None
        if not any(x['status']=='open' for x in state['incidents'].values()):
            epoch={'id':identity([closed_at,sorted(state['incidents'])]),'atMs':closed_at,
                   'closedIncidentIds':sorted(state['incidents'])}
            state.setdefault('measurementEpochs',[]).append(epoch)
        state['asOfMs']=closed_at
        team.write_json(str(store/'redline-state.json'),state)
        sample['redLines']=[dict(x) for x in state['incidents'].values() if x['status']=='open']
        sample['measurementEpoch']=epoch or next(iter(reversed(state.get('measurementEpochs',[]))),None)
        team.write_json(str(store/'live-alerts.json'),sample)
        team.quality_events.emit(team,root,'redline-closed',args.incident,
            at_ms=closed_at,incidentId=args.incident,rule=row['rule'],resolution=row['resolution'])
        if epoch:team.quality_events.emit(team,root,'measurement-epoch-started',epoch['id'],at_ms=closed_at,epoch=epoch)
        return row


def briefing(root):
    value=current(root)
    return ['', '## 未关闭红线（实时观察；消失不等于修复采用）',
            '观测时间：'+str(value.get('asOfMs')),
            *['- '+canonical({k:x.get(k) for k in ('id','rule','workItemId','attribution','evidence','triageDueAtMs','platformEscalation','triage')}).strip()
              for x in value['redLines']],
            '未知：'+canonical(value['unknown']).strip()]
