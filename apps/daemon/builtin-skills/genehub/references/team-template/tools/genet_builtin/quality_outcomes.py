"""Bounded integration references and time cost of complete acceptance units."""
import hashlib
import re
from .quality_score import canonical, number
from .task_hours import clipped, intervals, length, subtract, union

ADOPTION_BASIS = 'native-owner-use-reference/1'
COST_BASIS = 'complete-acceptance-unit-time/1'


def declared_uses(t, root, task, sid, values):
    uses = sorted(set(values))
    if len(uses) > 64:
        raise ValueError('at most 64 integration references per conclusion')
    for op in uses:
        if not re.fullmatch(r'taskop\.[0-9a-f]{64}', op):
            raise ValueError('use reference must be an existing operationId')
        row = t.read_dispatch_record(t.state_dir(root, 'task-dispatch', op+'.json'))
        request = (row or {}).get('request', {})
        person = next((x for x in task.get('collaborators', [])
                       if x.get('operationId') == op), {})
        if request.get('taskId') != task['taskId'] or request.get('requester') != sid or not person.get('finished'):
            raise ValueError('use reference requires this requester and a concluded child in this task')
    return uses


def integration_references(item, rounds):
    """Only explicit declarations in real completed native assistant rounds.

    Reasoning, quoted examples, mere links, and running/untimed replies do
    not establish use. Retain bounded references, never full reply bodies.
    """
    at = item.get('receivedAtMs')
    if item.get('type') != 'assistantMessage' or not number(at): return []
    round_ = next((x for x in rounds if x.get('outcome') == 'completed'
                   and number(x.get('startedAtMs')) and number(x.get('endedAtMs'))
                   and x['startedAtMs'] <= at <= x['endedAtMs']), None)
    if not round_: return []
    refs, fenced = [], False
    for line in item.get('text','').splitlines():
        if line.lstrip().startswith(('```','~~~')): fenced = not fenced; continue
        if fenced: continue
        match = re.fullmatch(r'\s*(?:采用|Uses)[:：]\s*(ghref:item:s_[0-9a-f]{32}:[A-Za-z0-9_.-]{1,200})\s*',line)
        if match: refs.append(dict(ref=match[1], atMs=at, messageId=item['id'], roundId=round_['roundId']))
    if len(refs) > 64: raise ValueError('too many integration references in a native reply')
    return refs


def adoption(work, tasks, log, native, cutoff):
    declarations = [x for x in log if x.get('kind') == 'conclusion']
    for task in tasks.values():
        for person in [task.get('owner') or {}] + task.get('collaborators', []):
            done = task.get('finished') if person is task.get('owner') else person.get('finished')
            if done:
                declarations.append(dict(done, taskId=task['taskId'], sessionId=person.get('sessionId')))
    reworked = {x['follows'] for x in work if x.get('follows')}
    for item in work:
        consumed = item.get('consumedAtMs')
        evidence = [x for x in declarations if x.get('taskId') == item.get('taskId')
                    and x.get('sessionId') == item.get('requester')
                    and x.get('outcome') in ('success', 'failed', 'blocked')
                    and item['id'] in x.get('uses', []) and number(consumed)
                    and number(x.get('atMs')) and consumed <= x['atMs'] <= cutoff]
        requester = native.get(item.get('requester'), {})
        result_refs = {ref.strip() for x in item.get('deliveryEvents', [])
                       if x.get('recipient') == item.get('requester')
                       for ref in (x.get('ref') or '').split(',') if ref.strip()}
        for ref in requester.get('integrationReferences', []):
            if ref.get('ref') in result_refs and number(consumed) and consumed <= ref['atMs'] <= cutoff:
                evidence.append(dict(ref,sessionId=item['requester'],via='native-integration-message'))
        evidence.sort(key=lambda x: x['atMs'])
        state = ('unobserved' if not number(consumed) else
                 'inferred' if consumed+600000 <= cutoff else 'read')
        item['adoptionEvidence'] = dict(basis=ADOPTION_BASIS, state='evidenced' if evidence else state,
                                      meaning='bounded requester integration declaration; not independent project acceptance')
        if evidence:
            item['adoptionEvidence'].update(atMs=evidence[0]['atMs'], sessionId=evidence[0]['sessionId'],
                                            operationId=item['id'], via=evidence[0].get('via','task-conclusion'))
            if evidence[0].get('messageId'):
                item['adoptionEvidence'].update(ownerMessageRef='ghref:item:'+evidence[0]['sessionId']+':'+evidence[0]['messageId'],
                                                resultRef=evidence[0]['ref'],roundId=evidence[0]['roundId'])
        item['disposition'] = ('rework' if item['id'] in reworked else
                               'adopted-evidenced' if evidence else 'adopted-inferred' if state == 'inferred' else None)
        # A later unmarked work stage could be planned serial work. Do not
        # infer rework from filenames, QA roles, or another work dispatch.
        item['reworkEvidence'] = 'explicit-follows' if item['id'] in reworked else (
            'unmarked-work-continuation' if rework_unknown(item,work) else 'unknown' if not evidence else 'no-declared-rework')


def rework_unknown(item, work):
    meta = item.get('acceptanceUnit') or {}
    concluded = item.get('conclusionAtMs')
    if not meta.get('id') or not number(concluded): return False
    if not item.get('taskId'): return True
    return any(x['id'] != item['id'] and x.get('taskId') == item.get('taskId')
               and (x.get('acceptanceUnit') or {}).get('id') == meta['id']
               and (x.get('acceptanceUnit') or {}).get('stage') == 'work'
               and not x.get('follows') and number(x.get('dispatchAtMs'))
               and x['dispatchAtMs'] >= concluded for x in work)


def evidenced(item, cutoff):
    proof = item.get('adoptionEvidence') or {}
    return (proof.get('basis') == ADOPTION_BASIS and proof.get('state') == 'evidenced'
            and proof.get('operationId') == item['id'] and proof.get('sessionId') == item.get('requester')
            and number(item.get('consumedAtMs')) and number(proof.get('atMs'))
            and item['consumedAtMs'] <= proof['atMs'] <= cutoff)


def comparison(request):
    value = (request.get('parameters') or {}).get('qualityComparison')
    if not isinstance(value, dict) or value.get('schema') != 'acceptance-comparison/1':
        return None
    if (not isinstance(value.get('scope'), str) or not 0 < len(value['scope']) <= 200
            or not number(value.get('size')) or value['size'] <= 0
            or any(not isinstance(value.get(k), str) or not re.fullmatch(r'[0-9a-f]{64}', value[k])
                   for k in ('inputSha256', 'acceptanceSha256'))):
        return None
    contract = {k: value[k] for k in ('schema', 'scope', 'size', 'inputSha256', 'acceptanceSha256')}
    return dict(key=hashlib.sha256(canonical(contract).encode()).hexdigest(), contract=contract,
                meaning='declared immutable comparable input and acceptance scope; not independent QA')


def costs(facts):
    """Called on the formal execution projection, never a diagnostic view."""
    work = {x['id']: x for x in facts.get('workItems', [])}
    output, memberships = [], {}
    for index, unit in enumerate(facts.get('acceptanceUnits', [])):
        for person in unit['sessions']:
            runs = subtract(clipped(intervals(person['runs']),
                max(unit['openedAtMs'],person.get('openedAtMs',unit['openedAtMs'])),unit['endedAtMs']),
                intervals(unit.get('excluded', [])))
            memberships.setdefault(person['sessionId'], []).append((index,runs))
    for index, unit in enumerate(facts.get('acceptanceUnits', [])):
        a,b = unit['openedAtMs'], unit['endedAtMs']
        rows, reasons = [], []
        if not unit.get('boundaryKnown'): reasons.append('acceptance-boundary-unknown')
        for person in unit['sessions']:
            runs = clipped(intervals(person['runs']), max(a,person.get('openedAtMs',a)), b)
            effective = subtract(union(runs), intervals(unit.get('excluded', [])))
            other = union(pair for member,rows in memberships[person['sessionId']] if member != index for pair in rows)
            assigned = subtract(effective,other)
            if length(assigned) < length(effective): reasons.append('shared-session-allocation-unknown')
            observed = length(assigned)
            rows.append(dict(sessionId=person['sessionId'], observedMs=observed))
            if person.get('readable') is not True or person.get('executionCoverageKnown') is not True:
                reasons.append('native-execution-history-incomplete')
            if person.get('partialCoverage'): reasons.append('shared-owner-allocation-unknown')
        members = [work.get(op) for op in unit.get('operationIds', [])]
        supports = [x for x in members if x and not x.get('owner')]
        # This is bounded integration evidence, never project QA acceptance.
        reworked = {x['follows'] for x in work.values() if x.get('follows')}
        used = bool(supports) and all(members) and all(evidenced(x,facts['capturedAtMs']) or x['id'] in reworked for x in supports)
        output.append(dict(unitId=unit['unitId'], taskId=unit['taskId'], openedAtMs=a, endedAtMs=b,
                           completed=bool(unit.get('conclusion')), conclusion=unit.get('conclusion'),
                           observedMs=sum(x['observedMs'] for x in rows), sessions=rows,
                           complete=not reasons, unknownReasons=sorted(set(reasons)),
                           integrationEvidenced=used, comparison=unit.get('costComparison')))
    return output


def baseline(rows, prior, cutoff):
    """Separate, versioned immutable first twenty complete units per scope."""
    if prior and (prior.get('schema') != 'team-unit-time-baselines/1' or prior.get('basis') != COST_BASIS):
        raise ValueError('unit time baseline has incompatible basis')
    result = dict(schema='team-unit-time-baselines/1', basis=COST_BASIS, groups=dict(prior.get('groups', {})))
    grouped = {}
    for row in rows:
        scope = row.get('comparison')
        if row['completed'] and row['complete'] and row['integrationEvidenced'] and scope:
            grouped.setdefault(scope['key'], {})[row['unitId']] = row
    for key, units in grouped.items():
        if key not in result['groups'] and len(units) >= 20:
            first = sorted(units.values(), key=lambda x: (x['endedAtMs'], x['unitId']))[:20]
            result['groups'][key] = dict(unitIds=[x['unitId'] for x in first],
                                        meanMs=sum(x['observedMs'] for x in first)/20,
                                        comparison=first[0]['comparison'], frozenAtMs=cutoff)
    return result
