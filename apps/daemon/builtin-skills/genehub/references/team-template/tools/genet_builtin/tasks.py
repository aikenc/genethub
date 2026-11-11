"""Task ownership is a file relationship between sessions, reconciled by the timer.

No Space is a worker lock. Resource claims live at the actual writer directory.
All operations persist their intent before starting or messaging another session.
"""
import hashlib
import json
import os
import re
import subprocess
from types import SimpleNamespace
from .runtime import get_runtime, json_value, check_decision
from .api import TeamConfigurationError
from . import resources, quality_events


def identity(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def task_path(t, root, task_id):
    if not task_id.startswith('task.') or not all(c in 'abcdefghijklmnopqrstuvwxyz0123456789.' for c in task_id):
        raise t.ExpertError('无效任务编号', '没有读写任务', '使用 task start 返回的 taskId')
    return t.state_dir(root, 'tasks', task_id + '.json')


def read_task(t, root, task_id):
    value = t.read_dispatch_record(task_path(t, root, task_id))
    if not value or value.get('version') != 1:
        raise t.ExpertError('任务不存在或版本不支持', '没有派单或迁移记录', '核对原 taskId 和定义源')
    get_runtime(root).verify_task(value)
    return value


def own_session(t):
    sid = os.environ.get('GENEHUB_SESSION_ID')
    if not sid or not t.SESSION_ID.fullmatch(sid):
        raise t.ExpertError('任务操作需要明确发起会话', '没有派单', '在前台或 Owner 会话中操作')
    return sid


def receipt(t, root, sid):
    for area in ('pending', 'done'):
        value = t.read_dispatch_record(t.state_dir(root, area, sid + '.json'))
        if value:
            return value
    return None


def dispatch(t, root, task, operation, role, desc, goal, requester, machine=None, directory=None, tier=None, model=None, parameters=None, follows=None, standing=False):
    """A stable per-operation intent; native creation and first input share its ID."""
    runtime = get_runtime(root)
    runtime.verify_task(task)
    op_id = 'taskop.' + identity(operation)
    path = t.state_dir(root, 'task-dispatch', op_id + '.json')
    saved = t.read_dispatch_record(path)
    if saved:
        machine = saved['request'].get('machine')
    else:
        route = t.role_route(root, role, machine)
        machine = route[1]['machineId'] if route else None
    request = dict(taskId=task['taskId'], role=role, desc=desc, goal=goal, requester=requester,
                   machine=machine, directory=directory, tier=tier, model=model)
    if parameters: request['parameters'] = json_value(parameters)
    if follows is not None:
        if not re.fullmatch(r'taskop\.[0-9a-f]{64}', follows) or not t.read_dispatch_record(t.state_dir(root, 'task-dispatch', follows + '.json')):
            raise t.ExpertError('follows 必须指向本团队已有派单', '没有创建支持单', '使用原支持单的 operationId')
        request['follows'] = follows
    if standing:
        request['standing'] = True
    req = resources.request(task['taskId'], role, goal, requester, machine, directory, parameters)
    resources.gate(runtime, req, op_id)
    with t.inbox_lock(root, op_id, purpose='任务派单'):
        old = t.read_dispatch_record(path)
        if old and old.get('request') != request:
            raise t.ExpertError('派单编号已用于不同内容', '没有重派', '用原参数读取原回执')
        if old and old.get('state') == 'withdrawn':
            raise t.ExpertError('原派单已持久撤回', '没有重新创建会话', '查询原任务；新业务使用新任务编号')
        if old and old.get('sessionId'):
            sid = old['sessionId']
            if not receipt(t, root, sid):
                t.write_json(t.state_dir(root, 'pending', sid + '.json'), old['pending'])
            if old.get('state') == 'prepared':
                activate(t, root, old, path)
            return old
        if old and old.get('state') == 'creating' and old.get('createAttempted') and not old.get('recoverable'):
            raise t.ExpertError('旧平台创建结果未知', '保留意图与资源，没有重派', '核对原生会话，或升级支持幂等创建的平台后恢复')
        name, mine = t.me(root)
        if (not machine and role not in mine.get('spaces', {})) or role in ('root', 'front', 'default'):
            raise t.ExpertError('目标不是已登记执行岗位', '没有派单', '先核对 directory；前台不作为写工位')
        if machine and directory:
            raise t.ExpertError('远端工位必须使用执行端固定绑定', '没有派单', '核对远端岗位的 WORKTREE_DIR')
        if not old:
            with t.inbox_lock(root, 'task-capacity', purpose='任务共享预算'):
                intents = records(t, root, 'task-dispatch')
                active = [x for x in intents if x.get('state') in ('creating', 'prepared') or
                          (x.get('sessionId') and os.path.exists(t.state_dir(root, 'pending', x['sessionId'] + '.json')))]
                maximum = int(t.setting(root, 'TEAM_MAX_ACTIVE_SESSIONS', 64))
                per_task = int(t.setting(root, 'TEAM_TASK_MAX_SESSIONS', 32))
                deadline = t.setting(root, 'TEAM_TASK_MAX_AGE_SECONDS', 7200) * 1000
                if len(active) >= maximum or sum(x.get('request', {}).get('taskId') == task['taskId'] for x in intents) >= per_task or t.now_ms() - task['createdAtMs'] > deadline:
                    raise t.ExpertError('团队或任务共享预算已到限额', '没有创建额外会话', '保留任务成果，核对预算后明确决定')
                old = dict(version=1, operationId=op_id, request=request, state='creating',
                           selection=None, lock=None, createdAtMs=t.now_ms(), recoverable=False, createAttempted=False)
                t.write_json(path, old)
        quality_events.emit(t, root, 'dispatch', op_id, at_ms=old['createdAtMs'],
                            taskId=task['taskId'], operationId=op_id, requester=requester,
                            role=role, machine=machine, follows=follows, standing=bool(standing))
        resolved = resources.prepare(t, root, old, req, path)
        lock = old.get('lock')
        picked = old.get('selection') if old else None
        if not machine and not picked:
            args, why = t.choose(root, t.role_model_key(role), tier, model, None, role=role)
            picked = [args, why]
        old.update(selection=picked, lock=lock)
        t.write_json(path, old)
        # Same CLI/daemon feature negotiation used by the normal agent run.
        features = (t.genet('context', *t.machine_args(machine)).get('daemon') or {}).get('features') or []
        recoverable = 'session.create-id.v1' in features if isinstance(features, list) else False
        if 'session.prepare.v1' not in features:
            raise t.ExpertError('执行端尚不支持准备会话后激活', '没有投递业务，原意图和资源保留', '先更新兼容guest，再复用原任务编号')
        record = old or dict(version=1, operationId=op_id, request=request, state='creating',
                             selection=picked, lock=lock, createdAtMs=t.now_ms(), recoverable=recoverable)
        record.update(selection=picked, lock=lock, recoverable=recoverable)
        t.write_json(path, record)
        prompt = ('[任务上下文] taskId=%s；本次派单=%s；请求方会话=%s。\n'
                  '你是该任务的负责执行会话，可以直接实施；需要支持时使用 task support，结果自动回到本会话。'
                  '收尾前用 task finish 提交明确结论和证据；普通中间回复不代表任务完成。\n%s\n%s'
                  % (task['taskId'], op_id, requester, ('固定业务目录：' + resolved) if resolved else '尚未认领业务写目录；修改项目前先 task bind-directory。', goal))
        remote = None
        record['prompt'] = prompt
        record['createAttempted'] = True
        t.write_json(path, record)
        sid = prepare_intent(t, root, record)
        # Ownership and the reverse dependency are durable BEFORE the Agent
        # can consume its first business input, including remote execution.
        if operation == task['taskId'] + ':owner':
            task['owner'] = dict(sessionId=sid, machine=machine, space=role)
            if resolved:
                task['executionBinding'] = dict(directory=resolved, sessionId=sid, lock=lock)
            t.write_json(task_path(t, root, task['taskId']), task)
        else:
            with t.inbox_lock(root, task['taskId'], purpose='激活前协作归属'):
                current = read_task(t, root, task['taskId'])
                if not any(x['operationId'] == op_id for x in current['collaborators']):
                    current['collaborators'].append(dict(operationId=op_id, sessionId=sid, machine=machine, requester=requester))
                    t.write_json(task_path(t, root, task['taskId']), current)
        activate(t, root, record, path)
        return record



def prepare_intent(t, root, record):
    """Retry only the acknowledged idempotent prepare primitive, never business."""
    request = record['request']
    machine, role = request.get('machine'), request['role']
    op_id, prompt = record['operationId'], record['prompt']
    lock, picked = record.get('lock'), record.get('selection')
    requester = request['requester']
    desc, tier, model = request['desc'], request.get('tier'), request.get('model')
    _, mine = t.me(root)
    remote = None
    if machine:
        target = record.get('target') or t.remote_target(root, machine, role)
        record['target'] = target
        record.setdefault('returnTo', t.source_route(root))
        t.write_json(t.state_dir(root, 'task-dispatch', op_id + '.json'), record)
        remote_request = dict(id=op_id, workspaceId=target['workspaceId'], role=role, desc=desc, text=prompt,
                              tier=tier, model=model, media=None, prepareOnly=True, returnTo=record['returnTo'])
        result = t.remote_receive(target, remote_request)
        sid, why = result['sessionId'], result['why']
        remote = dict(id=op_id, target=target)
    else:
        sid, why = t.start(root, mine['spaces'][role], role, desc, prompt, t.role_model_key(role),
                           selection=(picked[0], picked[1]), operation_id=op_id, prepare_only=True)
    if not sid:
        raise t.ExpertError('派单创建回执未知', '原编号、意图和资源保留', '用同一 task 操作重试，禁止换编号')
    if lock:
        with t.inbox_lock(os.path.dirname(lock), 'writer', purpose='已准备会话资源归属'):
            holder = t.read_json(lock, {}) or {}
            if holder.get('requestId') != op_id:
                raise TeamConfigurationError('prepared session lost its exact resource lease')
            t.write_json(lock, dict(session=sid, requestId=op_id, at=t.now_ms()))
    if record.get('resourceBinding'):
        record['resourceBinding']['session_id'] = sid
    pending = dict(sessionId=sid, requester=requester, batch=request['taskId'] + ':' + requester,
                   kind=role, desc=desc, createdAtMs=record['createdAtMs'], baseline=None,
                   notified=[], lock=lock, route=why, taskId=request['taskId'], operationId=op_id)
    if machine:
        pending.update(machine=machine, remoteDispatch=remote)
    record.update(state='prepared', sessionId=sid, pending=pending, prompt=prompt)
    # If interrupted after this receipt, retry reconstructs the same pending relationship.
    t.write_json(t.state_dir(root, 'task-dispatch', op_id + '.json'), record)
    t.write_json(t.state_dir(root, 'pending', sid + '.json'), pending)
    quality_events.emit(t, root, 'dispatch-confirmed', op_id, taskId=request['taskId'],
                        operationId=op_id, sessionId=sid, machine=machine)
    return sid


def activate(t, root, record, path):
    task = read_task(t, root, record['request']['taskId'])
    if task.get('state') != 'active' or task.get('finished'):
        raise t.ExpertError('任务控制中或已收尾', '会话已准备但没有激活业务', '按原任务控制回执恢复，不能换编号')
    sid = record['sessionId']
    owner_op = 'taskop.' + identity(task['taskId'] + ':owner')
    if record['operationId'] == owner_op and not task.get('owner'):
        task['owner'] = dict(sessionId=sid, machine=record['request'].get('machine'), space=record['request']['role'])
        if record['request'].get('directory'):
            task['executionBinding'] = dict(directory=t.resolve_expert_dir(root, record['request']['directory']), sessionId=sid, lock=record.get('lock'))
        t.write_json(task_path(t, root, task['taskId']), task)
    elif record['operationId'] != owner_op and not any(x['operationId'] == record['operationId'] for x in task['collaborators']):
        with t.inbox_lock(root, task['taskId'], purpose='恢复激活前依赖'):
            current = read_task(t, root, task['taskId'])
            current['collaborators'].append(dict(operationId=record['operationId'], sessionId=sid, machine=record['request'].get('machine'), requester=record['request']['requester']))
            t.write_json(task_path(t, root, task['taskId']), current)
    remote = record['pending'].get('remoteDispatch')
    if remote:
        target = remote['target']
        t.remote_receive(target, dict(id=remote['id'], workspaceId=target['workspaceId'], role=record['request']['role'],
                                      operation='activate', sessionId=sid))
    else:
        t.genet('session', 'send', sid, record['prompt'], '--system', '--message-id', record['operationId'], '--no-wait')
    record['state'] = 'created'
    t.write_json(path, record)
    quality_events.emit(t, root, 'input-accepted', record['operationId'],
                        taskId=task['taskId'], operationId=record['operationId'],
                        sessionId=sid, messageId=('activate.' + identity(remote['id']) if remote else record['operationId']), purpose='task',
                        machine=record['request'].get('machine'), timeBasis='observed-acceptance')


def forward(t, root, args):
    binding = t.received_route(root, own_session(t)) or t.read_dispatch_record(os.path.join(root, '.genethub', 'task-source.json'))
    if not binding:
        return False
    envelope = vars(args).copy()
    envelope['sender'] = own_session(t)
    result = t.remote_receive(binding, dict(operation='task-operation', id='task-forward.' + identity(json.dumps(envelope, sort_keys=True)),
                                           workspaceId=binding['workspaceId'], role=binding['role'], taskOperation=envelope))
    print(json.dumps(result, ensure_ascii=False))
    return True


def command(t, args, root=None, sender=None):
    root = root or t.find_root()
    if sender is None and forward(t, root, args):
        return
    sid = sender or own_session(t)
    runtime = get_runtime(root)
    parameters = getattr(args, 'parameters', None) or {}
    if isinstance(parameters, str):
        try: parameters = json.loads(parameters)
        except ValueError as error: raise TeamConfigurationError('parameters must be JSON') from error
    if not isinstance(parameters, dict):
        raise TeamConfigurationError('parameters must be a JSON object')
    parameters = json_value(parameters)
    action = args.task_action
    if action == 'start':
        if not args.request_id:
            raise t.ExpertError('task start 需要稳定 --request-id', '没有创建任务', '新任务选择编号；恢复使用原编号')
        task_id = 'task.' + identity(args.request_id)
        path = task_path(t, root, task_id)
        requested = dict(role=args.space, goal=' '.join(args.words), desc=args.desc, machine=args.machine,
                         directory=args.directory, tier=args.tier, model=args.model)
        if parameters: requested['parameters'] = parameters
        with t.inbox_lock(root, task_id, purpose='任务归属'):
            task = t.read_dispatch_record(path)
            if task and (task.get('request') != requested or task.get('front') != sid):
                raise t.ExpertError('任务编号已用于不同内容或发起方', '没有重派或抢走归属', '查询原任务；独立新目标使用新编号')
            if task: runtime.verify_task(task)
            if not task:
                resources.gate(runtime, resources.request(task_id, args.space, requested['goal'], sid, args.machine or t.role_machine(root, args.space) or (t.remote_targets(root).get(args.space) or {}).get('machineId'), args.directory, parameters), 'taskop.' + identity(task_id + ':owner'))
                task = dict(framework=runtime.identity(), version=1, taskId=task_id, request=requested, front=sid, owner=None,
                            state='active', revision=1, createdAtMs=t.now_ms(), collaborators=[])
                t.write_json(path, task)
            quality_events.emit(t, root, 'task-created', task_id, at_ms=task['createdAtMs'],
                                taskId=task_id, front=sid)
            result = dispatch(t, root, task, task_id + ':owner', args.space, args.desc, requested['goal'], sid,
                              args.machine, args.directory, args.tier, args.model, parameters)
            if not task.get('owner'):
                task['owner'] = dict(sessionId=result['sessionId'], machine=result['request'].get('machine'), space=args.space)
                if args.directory:
                    task['executionBinding'] = dict(directory=t.resolve_expert_dir(root, args.directory), sessionId=result['sessionId'], lock=result.get('lock'))
                t.write_json(path, task)
        publish(t, root)
        print(json.dumps(dict(taskId=task_id, owner=task['owner'], state=task['state']), ensure_ascii=False))
        return
    task = read_task(t, root, args.task_id)
    path = task_path(t, root, args.task_id)
    if action == 'status':
        print(json.dumps(task, ensure_ascii=False)); return
    if action in ('support', 'finish', 'bind-directory') and sid != (task.get('owner') or {}).get('sessionId'):
        # A collaborator can finish its own bounded work, but cannot finish another owner's task.
        mine = next((x for x in task.get('collaborators', []) if x['sessionId'] == sid), None)
        if action not in ('finish', 'support', 'bind-directory') or mine is None:
            raise t.ExpertError('当前会话不是此操作的任务负责人', '没有改变归属', '核对任务的 Owner；接手必须显式进行')
    if action in ('pause', 'resume', 'cancel', 'handover'):
        return control(t, root, task, args, sid)
    if action == 'support':
        if task.get('state') != 'active' or task.get('finished'):
            raise t.ExpertError('任务已收尾', '没有新增协作', '新目标建立新任务')
        if not args.request_id:
            raise t.ExpertError('支持请求需要 --request-id', '没有派单', '重试复用本次支持编号')
        op = task['taskId'] + ':support:' + args.request_id
        result = dispatch(t, root, task, op, args.space, args.desc, ' '.join(args.words), sid,
                          args.machine, args.directory, args.tier, args.model, parameters,
                          follows=getattr(args, 'follows', None), standing=getattr(args, 'standing', False))
        with t.inbox_lock(root, task['taskId'], purpose='协作关系'):
            task = read_task(t, root, task['taskId'])
            if not any(x['operationId'] == result['operationId'] for x in task['collaborators']):
                task['collaborators'].append(dict(operationId=result['operationId'], sessionId=result['sessionId'], machine=result['request'].get('machine'), requester=sid))
                t.write_json(path, task)
        publish(t, root)
        print(json.dumps(dict(taskId=task['taskId'], collaborator=result['sessionId']), ensure_ascii=False))
    elif action == 'finish':
        outstanding = [x for x in records(t, root, 'pending') if x.get('requester') == sid and not x.get('done')]
        if outstanding and args.outcome == 'success':
            raise t.ExpertError('必需协作尚未结算', '没有把任务标成成功', '核对支持结果或明确报告阻塞')
        with t.inbox_lock(root, task['taskId'], purpose='任务结论'):
            task = read_task(t, root, task['taskId'])
            outcome = dict(outcome=args.outcome, evidence=' '.join(args.words), atMs=t.now_ms())
            prior = task.get('finished') if sid == task['owner']['sessionId'] else next((x.get('finished') for x in task['collaborators'] if x['sessionId'] == sid), None)
            if prior:
                if prior.get('outcome') != args.outcome or prior.get('evidence') != outcome['evidence']:
                    raise t.ExpertError('原任务结论已记录', '没有覆盖结论', '新要求通过明确恢复继续原任务')
                outcome = prior
            if not prior and args.outcome == 'success':
                decision = check_decision(runtime.workflow.check_completion(runtime.for_operation(task['taskId'] + ':' + sid), completion_view(task, sid, outcome)))
                if not decision.allowed:
                    raise TeamConfigurationError('completion ' + decision.status + ': ' + decision.reason)
            if sid == task['owner']['sessionId']:
                task['finished'] = outcome
            else:
                for item in task['collaborators']:
                    if item['sessionId'] == sid:
                        item['finished'] = outcome
            t.write_json(path, task)
        quality_events.emit(t, root, 'conclusion', task['taskId'] + ':' + sid + ':' + str(outcome['atMs']),
                            at_ms=outcome['atMs'], taskId=task['taskId'], sessionId=sid,
                            outcome=outcome['outcome'])
        print(json.dumps(dict(taskId=task['taskId'], recorded=True), ensure_ascii=False))
    elif action == 'send':
        if not args.request_id:
            raise t.ExpertError('补充消息需要稳定编号', '没有投递', '用 --request-id 保留本次输入身份')
        owner = task['owner']
        send_path = t.state_dir(root, 'task-inputs', identity(task['taskId'] + ':' + args.request_id) + '.json')
        input_request = dict(taskId=task['taskId'], sender=sid, owner=owner, text=' '.join(args.words))
        with t.inbox_lock(root, 'input-' + identity(task['taskId'] + args.request_id), purpose='任务追加要求'):
            prior = t.read_dispatch_record(send_path)
            if prior and prior.get('request') != input_request:
                raise t.ExpertError('同一输入编号对应不同内容或Owner版本', '没有投递第二条要求', '重试使用原参数；新要求用新编号')
            if not prior:
                prior = dict(request=input_request, state='prepared'); t.write_json(send_path, prior)
            t.deliver_or_notice(root, owner['sessionId'], 'human', sid, input_request['text'],
                                task['taskId'], args.request_id, machine=owner.get('machine'))
            prior['state'] = 'accepted'; t.write_json(send_path, prior)
        print(json.dumps(dict(taskId=task['taskId'], accepted=True), ensure_ascii=False))
    elif action == 'bind-directory':
        print(json.dumps(bind_directory(t, root, task['taskId'], sid, args.directory), ensure_ascii=False))


def completion_view(task, sid, outcome):
    """API 1 projection; internal control/dispatch ledger is not a business API."""
    return json_value(dict(taskId=task['taskId'], sessionId=sid, outcome=outcome['outcome'],
                           evidence=outcome['evidence'], parameters=task['request'].get('parameters', {}),
                           supports=[dict(sessionId=x['sessionId'], outcome=(x.get('finished') or {}).get('outcome'),
                                          evidence=(x.get('finished') or {}).get('evidence')) for x in task.get('collaborators', [])]))


def bind_directory(t, root, task_id, sid, requested):
    # The resource belongs to this executing session, including collaborators.
    # Match task -> resource lock order used by explicit handover/control.
    with t.inbox_lock(root, task_id, purpose='任务工位'):
        task = read_task(t, root, task_id)
        participant = task['owner'] if task['owner']['sessionId'] == sid else next((x for x in task['collaborators'] if x['sessionId'] == sid), None)
        if participant is None:
            raise t.ExpertError('会话不属于该任务', '没有认领工位', '核对原派单')
        outcome = task.get('finished') if participant is task['owner'] else participant.get('finished')
        if task.get('state') != 'active' or outcome:
            raise t.ExpertError('任务已暂停、控制中或本会话已结算', '没有新增写资源', '先明确恢复原任务')
        pending_path = t.state_dir(root, 'pending', sid + '.json')
        pending = t.read_dispatch_record(pending_path)
        if not pending or pending.get('taskId') != task_id:
            raise t.ExpertError('执行回执缺失', '没有认领资源', '恢复原派单回执')
        machine = participant.get('machine')
        if machine:
            dispatch = pending.get('remoteDispatch') or {}
            target = dispatch.get('target')
            if not target or pending.get('remoteReleased'):
                raise t.ExpertError('远端执行回执不可用', '没有在源端冒认远端路径', '恢复原接单回执')
            reply = t.remote_receive(target, dict(id=dispatch['id'], operation='bind-directory', sessionId=sid,
                workspaceId=target['workspaceId'], role=pending['kind'], directory=requested))
            binding = dict(reply['binding'], machine=machine)
        else:
            operation = pending.get('operationId') or ('taskbind.' + identity(task_id + sid))
            intent_path = t.state_dir(root, 'task-dispatch', operation + '.json')
            intent = t.read_dispatch_record(intent_path) or {}
            directory = t.resolve_expert_dir(root, requested)
            prior = intent.get('resourceBinding')
            if prior and prior['directory'] != directory:
                raise TeamConfigurationError('session already has a resource; explicit handover required')
            if not intent:
                intent = dict(version=1, operationId=operation, request=dict(taskId=task_id), state='created', sessionId=sid)
            original = intent.get('request') or {}
            req = resources.request(task_id, original.get('role', pending['kind']), original.get('goal', task['request']['goal']),
                                    pending['requester'], None, directory, original.get('parameters', {}))
            resources.gate(get_runtime(root), req, operation)
            if intent.get('resourcePlan') is None:
                intent.pop('resourcePlan', None)
            resolved = resources.prepare(t, root, intent, req, intent_path)
            if not resolved:
                raise TeamConfigurationError('resource policy did not bind the requested directory')
            binding = dict(directory=resolved, sessionId=sid, lock=intent['lock'])
            pending['lock'] = intent['lock']
            pending['operationId'] = operation
            t.write_json(pending_path, pending)
        if participant is task['owner']:
            task['executionBinding'] = binding
        else:
            participant['executionBinding'] = binding
        t.write_json(task_path(t, root, task_id), task)
        return binding




def control(t, root, task, args, sender):
    if sender != task.get('front'):
        raise t.ExpertError('任务级控制应由原前台转达明确用户要求', '没有控制协作树', '单会话中断使用原生会话操作')
    path = task_path(t, root, task['taskId'])
    with t.inbox_lock(root, task['taskId'], purpose='任务控制'):
        task = read_task(t, root, task['taskId'])
        operation = task.get('control')
        request = dict(id=args.request_id, action=args.task_action, expectedRevision=args.expected_revision,
                       words=getattr(args, 'words', []), sessionId=getattr(args, 'session', None), machine=getattr(args, 'machine', None))
        if operation and operation.get('request', {}).get('id') == args.request_id:
            if operation['request'] != request:
                raise t.ExpertError('控制编号已用于不同内容', '没有重复控制', '使用原参数查回执')
        else:
            if operation and not operation.get('complete'):
                raise t.ExpertError('原任务控制尚未完成', '没有启动另一次控制', '查询原任务和原操作')
            if task['revision'] != args.expected_revision:
                raise t.ExpertError('任务版本已变化', '没有改变归属', '先 task status 再决定')
            if task.get('state') in ('delivered', 'canceled'):
                raise t.ExpertError('任务已终结', '没有自动恢复已交付或取消的工作', '新的用户目标建立新任务并引用原成果')
            if args.task_action == 'handover':
                if args.machine or (task.get('owner') or {}).get('machine'):
                    raise t.ExpertError('跨机Owner接手需要显式成果和执行端资源交接', '原Owner未被中断，归属和资源保留', '本版只支持同机独立会话接手；跨机先核对产物和原执行端释放回执')
                if not args.session or not t.SESSION_ID.fullmatch(args.session) or receipt(t, root, args.session):
                    raise t.ExpertError('新Owner必须是没有任务回执的独立会话', '未中断原Owner', '先准备同机新会话')
                target_summary = t.session_summary(args.session)
                if target_summary.get('status') != 'idle' or (target_summary.get('inputSummary') or {}).get('paused') or (target_summary.get('inputSummary') or {}).get('pendingMessageIds'):
                    raise t.ExpertError('接手会话有运行或待处理输入', '未中断原Owner', '等待新会话空闲再明确接手')
            targets = [dict(sessionId=task['owner']['sessionId'], machine=task['owner'].get('machine'))] if task.get('owner') else []
            targets += [dict(sessionId=x['sessionId'], machine=x.get('machine')) for x in task.get('collaborators', [])
                        if args.task_action != 'handover' and not x.get('finished')]
            operation = dict(request=request, targets=targets, completed=[], complete=False, sender=sender)
            task['control'] = operation
            task['state'] = {'pause': 'pausing', 'resume': 'resuming', 'cancel': 'canceling', 'handover': 'handing-over'}[args.task_action]
            t.write_json(path, task)
    reconcile_control(t, root, task)
    publish(t, root)
    print(json.dumps(read_task(t, root, task['taskId']), ensure_ascii=False))


def reconcile_control(t, root, task):
    # Serialize the existing file controller, including I/O acknowledgements.
    # Reload after acquiring: a stale timer snapshot must not overwrite a new
    # participant, conclusion, control revision or ownership change.
    with t.inbox_lock(root, task['taskId'], purpose='任务控制对账'):
        return _reconcile_control(t, root, read_task(t, root, task['taskId']))


def _reconcile_control(t, root, task):
    operation = task.get('control')
    if not operation or operation.get('complete'):
        return
    request = operation['request']
    action = request['action']
    intents = [x for x in records(t, root, 'task-dispatch') if x.get('request', {}).get('taskId') == task['taskId']]
    for intent in intents:
        if intent.get('state') == 'creating' and intent.get('createAttempted'):
            if not intent.get('recoverable') or not intent.get('prompt'):
                return  # unknown execution is an obligation, never an empty tree
            # Resolve the original creation identity while the task is paused;
            # no Agent receives its first input during cancellation/recovery.
            prepare_intent(t, root, intent)

    known = {(x.get('machine'), x['sessionId']) for x in operation['targets']}
    for intent in intents:
        address = (intent.get('request', {}).get('machine'), intent.get('sessionId'))
        if action != 'handover' and address[1] and address not in known:
            record = receipt(t, root, address[1])
            if record and not record.get('done'):
                operation['targets'].append(dict(machine=address[0], sessionId=address[1])); known.add(address)
    for item in task.get('collaborators', []):
        if action != 'handover' and not item.get('finished') and (item.get('machine'), item['sessionId']) not in known:
            operation['targets'].append(dict(machine=item.get('machine'), sessionId=item['sessionId']))
    for target in operation['targets']:
        key = (target.get('machine') or '') + ':' + target['sessionId']
        if key in operation['completed']:
            continue
        summary = t.session_summary(target['sessionId'], target.get('machine'))
        paused = (summary.get('inputSummary') or {}).get('paused')
        if action in ('pause', 'cancel', 'handover'):
            if not paused:
                t.genet('session', 'interrupt', target['sessionId'], *t.machine_args(target.get('machine')))
                return  # acknowledgement is not stopped execution
            if summary.get('status') in ('running', 'waiting'):
                return
            processes = t.genet('process', 'list', *t.machine_args(target.get('machine'))).get('processes')
            if not isinstance(processes, list) or any(x.get('sessionId') == target['sessionId'] for x in processes):
                return
        elif action == 'resume':
            # The original explicit Human continuation is durably retried, never
            # synthesized from a timer's ordinary result notice.
            text = request['words'] or ['继续原任务并核对未完成协作与资源。']
            args = SimpleNamespace(to=target['sessionId'], kind='human', text=text,
                                   message_id='taskresume.' + identity(task['taskId'] + request['id'] + key))
            t.send_explicit_resume(root, args, operation['sender'], target.get('machine'))
        operation['completed'].append(key)
        t.write_json(task_path(t, root, task['taskId']), task)
    if action == 'handover':
        new_sid = request.get('sessionId')
        if not new_sid or not t.SESSION_ID.fullmatch(new_sid):
            raise t.ExpertError('接手需要明确的新会话', '旧Owner已暂停，归属未切换', '先准备新会话再提供其SID')
        if not operation.get('handoverApplied'):
            summary = t.session_summary(new_sid, request.get('machine'))
            if summary.get('status') != 'idle' or (summary.get('inputSummary') or {}).get('paused') :
                raise t.ExpertError('新Owner不是可接手的独立会话', '未修改任务归属', '使用没有活动任务的新会话')
            if request.get('machine'):
                target_receipt = receipt(t, root, new_sid)
                if not target_receipt or not target_receipt.get('remoteDispatch'):
                    raise t.ExpertError('远端接手会话缺少原执行端回执', '归属未切换', '先通过正式派单准备接手机位和会话')
            binding = task.get('executionBinding')
            if binding:
                if request.get('machine') != task['owner'].get('machine'):
                    raise t.ExpertError('跨机工位接手需要先显式交接资源', '没有移动项目或改写锁', '完成成果交接后再选择新工位')
                lock = binding['lock']
                with t.inbox_lock(os.path.dirname(lock), 'writer', purpose='工位接手'):
                    holder = t.read_json(lock, {}) or {}
                    if holder.get('session') not in (task['owner']['sessionId'], new_sid):
                        raise t.ExpertError('原工位归属已经变化', '没有覆盖新写者', '核对资源后再接手')
                    holder['session'] = new_sid; t.write_json(lock, holder)
                binding['sessionId'] = new_sid
            for snapshot in records(t, root, 'task-dispatch'):
                if snapshot.get('sessionId') == task['owner']['sessionId'] and snapshot.get('resourceBinding'):
                    with t.inbox_lock(root, snapshot['operationId'], purpose='业务资源交接'):
                        intent_path = t.state_dir(root, 'task-dispatch', snapshot['operationId'] + '.json')
                        intent = t.read_dispatch_record(intent_path)
                        if intent and intent.get('sessionId') == task['owner']['sessionId']:
                            intent['sessionId'] = new_sid
                            intent['resourceBinding']['session_id'] = new_sid
                            t.write_json(intent_path, intent)
            task.setdefault('previousOwners', []).append(task['owner'])
            previous_sid = task['owner']['sessionId']
            task['owner'] = dict(sessionId=new_sid, machine=request.get('machine'), space=summary.get('workspaceId'))
            for entry in records(t, root, 'pending'):
                if entry.get('taskId') == task['taskId']:
                    if entry.get('sessionId') == previous_sid:
                        entry['superseded'] = True
                        entry['lock'] = None  # the lock was explicitly transferred above
                    elif entry.get('requester') == previous_sid:
                        entry['requester'] = new_sid
                    t.write_json(t.state_dir(root, 'pending', entry['sessionId'] + '.json'), entry)
            task.pop('finished', None)
            # Track the new owner's final conclusion using the existing pending path.
            pending = dict(sessionId=new_sid, requester=task['front'], batch=task['taskId'], kind='work',
                           desc=task['request']['desc'], createdAtMs=t.now_ms(), baseline=(summary.get('latestReply') or {}).get('itemId'),
                           notified=[], lock=binding.get('lock') if binding else None, taskId=task['taskId'], route='explicit-handover', operationId=('taskop.' + identity(task['taskId'] + ':owner')))
            t.write_json(t.state_dir(root, 'pending', new_sid + '.json'), pending)
            operation['handoverApplied'] = True
            t.write_json(task_path(t, root, task['taskId']), task)
        t.deliver_or_notice(root, new_sid, 'task', operation['sender'],
                            '接手任务 %s。原目标：%s。先核对成果、工位和仍需处理的协作，勿重做已完成副作用。' % (task['taskId'], task['request']['goal']),
                            task['taskId'], request['id'], machine=request.get('machine'))
    if action == 'cancel':
        for entry in records(t, root, 'pending'):
            if entry.get('taskId') == task['taskId']:
                entry['taskCanceled'] = True
                entry['done'] = dict(outcome='canceled', reply='task-cancel:' + request['id'], text='用户已取消本任务，保留已有成果和原会话。', ref=None)
                path = t.state_dir(root, 'pending', entry['sessionId'] + '.json')
                t.write_json(path, entry)
                t.move(root, path, entry)
                if os.path.exists(path):
                    return
    if action == 'cancel':
        for intent in intents:
            if not intent.get('sessionId') and intent.get('lock'):
                if intent.get('resourceBinding'):
                    decision = resources.release_decision(root, intent)
                    intent['resourceRelease'] = dict(status=decision.status, reason=decision.reason, checkedAtMs=t.now_ms())
                    t.write_json(t.state_dir(root, 'task-dispatch', intent['operationId'] + '.json'), intent)
                    if not decision.allowed:
                        return
                lock = intent['lock']
                with t.inbox_lock(os.path.dirname(lock), 'writer', purpose='取消未激活资源'):
                    holder = t.read_json(lock, {}) or {}
                    if holder.get('requestId') == intent['operationId'] and holder.get('session') is None:
                        os.remove(lock)
            intent['state'] = 'canceled'
            t.write_json(t.state_dir(root, 'task-dispatch', intent['operationId'] + '.json'), intent)
    task['revision'] += 1
    operation['complete'] = True
    task['state'] = {'pause': 'paused', 'resume': 'active', 'cancel': 'canceled', 'handover': 'active'}[action]
    if action == 'resume': task.pop('finished', None)
    t.write_json(task_path(t, root, task['taskId']), task)
    quality_events.emit(t, root, 'control', task['taskId'] + ':' + str(task['revision']),
                        taskId=task['taskId'], action=action, state=task['state'], revision=task['revision'])


def records(t, root, area):
    directory = t.state_dir(root, area)
    if not os.path.isdir(directory):
        return []
    values = []
    for name in sorted(os.listdir(directory)):
        if name.endswith('.json'):
            record = t.read_dispatch_record(os.path.join(directory, name))
            if record:
                values.append(record)
    return values


def recover_concluded_archives(t, root):
    """Recover an old missing result subscription, never rerun its business.

    Older timers could archive an explicit conclusion after advancing the
    reply baseline. A completed result payload, explicit controls or a newer
    subscription are not this migration and must remain untouched.
    """
    for saved in records(t, root, 'done'):
        sid, task_id, operation = saved.get('sessionId'), saved.get('taskId'), saved.get('operationId')
        if not (sid and t.SESSION_ID.fullmatch(sid) and task_id and operation
                and re.fullmatch(r'taskop\.[0-9a-f]{64}', operation)):
            continue
        if not saved.get('taskConclusion') or saved.get('done') or not saved.get('requester'):
            continue
        if any(saved.get(k) for k in ('quiet', 'superseded', 'taskCanceled', 'stopReason', 'resumeRequestId')):
            continue
        with t.inbox_lock(root, task_id, purpose='结论交付恢复'):
            try:
                task = read_task(t, root, task_id)
            except (t.ExpertError, TeamConfigurationError) as error:
                t.record_system_issue(root, 'result-recovery', str(error), operation)
                continue
            if task.get('state') in ('paused', 'pausing', 'canceling', 'canceled') or (task.get('control') and not task['control'].get('complete')):
                continue
            owner = (task.get('owner') or {}).get('sessionId') == sid
            participant = next((x for x in task.get('collaborators', [])
                                if x.get('sessionId') == sid and x.get('operationId') == operation), {})
            conclusion = task.get('finished') if owner else participant.get('finished')
            if conclusion != saved['taskConclusion']:
                continue
            intent = t.read_dispatch_record(t.state_dir(root, 'task-dispatch', operation + '.json')) or {}
            request = intent.get('request') or {}
            if (intent.get('state') != 'created' or intent.get('sessionId') != sid
                    or request.get('taskId') != task_id or request.get('requester') != saved['requester']
                    or request.get('machine') != saved.get('machine')):
                continue
            if owner and operation != 'taskop.' + identity(task_id + ':owner'):
                continue
            pending = t.state_dir(root, 'pending', sid + '.json')
            with t.inbox_lock(root, 'pending-' + sid, purpose='恢复原结果订阅'):
                # Recheck after the lock: explicit continuation may have
                # installed a new subscription while this scan was running.
                current = t.read_dispatch_record(t.state_dir(root, 'done', sid + '.json'))
                if os.path.exists(pending) or current != saved:
                    continue
                t.write_json(pending, saved)



def release_local(t, root, record):
    if record.get('machine') or not record.get('lock'):
        return True
    operation = record.get('operationId')
    intent_path = t.state_dir(root, 'task-dispatch', operation + '.json') if operation else None
    intent = t.read_dispatch_record(intent_path) if intent_path else None
    if intent and intent.get('resourceReleased') and intent.get('sessionId') == record['sessionId']:
        return True  # this lease ended; do not inspect or touch its successor
    summary = t.session_summary(record['sessionId'])
    inputs = summary.get('inputSummary') or {}
    if summary.get('status') not in ('idle', 'failed') or (not record.get('taskCanceled') and (inputs.get('paused') or inputs.get('pendingMessageIds'))):
        return False
    processes = t.genet('process', 'list').get('processes')
    if not isinstance(processes, list) or any(x.get('sessionId') == record['sessionId'] for x in processes):
        return False
    lock = record['lock']
    with t.inbox_lock(os.path.dirname(lock), 'writer', purpose='任务工位释放'):
        holder = t.read_json(lock, {}) or {}
        if not holder:
            operation = record.get('operationId')
            if operation:
                path = t.state_dir(root, 'task-dispatch', operation + '.json')
                original = t.read_dispatch_record(path)
                if original and original.get('resourceBinding'):
                    original['resourceReleased'] = True
                    t.write_json(path, original)
            return True
        if holder.get('session') != record['sessionId']:
            raise t.ExpertError('工位已属于另一个会话', '没有删除新写者的锁', '核对原任务交接')
        operation = record.get('operationId')
        intent_path = t.state_dir(root, 'task-dispatch', operation + '.json') if operation else None
        intent = t.read_dispatch_record(intent_path) if intent_path else None
        if intent and intent.get('resourceBinding'):
            if holder.get('requestId') != intent['operationId']:
                raise TeamConfigurationError('resource lease operation changed; original writer retained')
            get_runtime(root).verify_task(read_task(t, root, record['taskId']))
            decision = resources.release_decision(root, intent)
            intent['resourceRelease'] = dict(status=decision.status, reason=decision.reason, checkedAtMs=t.now_ms())
            t.write_json(intent_path, intent)
            if not decision.allowed:
                return True  # result delivery and resource reuse are different obligations
        os.remove(lock)
        quality_events.emit(t, root, 'resource-released', operation or record['sessionId'],
                            taskId=record.get('taskId'), operationId=operation,
                            sessionId=record['sessionId'], proof='local-idle-process-and-lease-check')
        if intent and intent.get('resourceBinding'):
            intent['resourceReleased'] = True
            t.write_json(intent_path, intent)
    return True



def reconcile_withdrawals(t, root):
    """Fence only uncreated remote preparations after their parent concluded.

    No receipt is not a negative acknowledgement. The executor must first
    serialize a durable fence with its normal receive/install operations.
    """
    concluded = {x.get('taskId') for x in records(t, root, 'tasks')
                 if x.get('finished') or x.get('state') in ('delivered', 'canceled')}
    candidates = [x for x in records(t, root, 'task-dispatch')
                  if x.get('state') == 'creating' and not x.get('sessionId')
                  and x.get('request', {}).get('taskId') in concluded
                  and x.get('request', {}).get('machine') and x.get('target')
                  and not x.get('lock') and not x.get('resourceBinding')
                  and x.get('withdrawRetryAtMs', 0) <= t.now_ms()]
    candidates.sort(key=lambda x: x.get('withdrawCheckedAtMs', 0))
    for snapshot in candidates[:2]:
        operation = snapshot['operationId']
        with t.inbox_lock(root, operation, purpose='已结束任务准备撤回'):
            path = t.state_dir(root, 'task-dispatch', operation + '.json')
            intent = t.read_dispatch_record(path)
            if (not intent or intent.get('state') != 'creating' or intent.get('sessionId')
                    or intent.get('lock') or intent.get('resourceBinding')):
                continue
            task = read_task(t, root, intent['request']['taskId'])
            if not task.get('finished') and task.get('state') not in ('delivered', 'canceled'):
                continue
            request, target = intent['request'], intent['target']
            # Reconstruct the exact original target-side prepare envelope.
            if not intent.get('prompt') or not intent.get('returnTo'):
                continue
            original = dict(id=operation, workspaceId=target['workspaceId'], role=request['role'],
                            desc=request['desc'], text=intent['prompt'], tier=request.get('tier'),
                            model=request.get('model'), media=None, prepareOnly=True, returnTo=intent['returnTo'])
            intent['withdrawCheckedAtMs'] = t.now_ms()
            intent['withdrawRetryAtMs'] = t.now_ms() + 300_000
            t.write_json(path, intent)
            try:
                result = t.remote_receive(target, dict(id=operation, workspaceId=target['workspaceId'],
                    role=request['role'], operation='withdraw-prepare', originalRequest=original))
                intent['withdrawReceipt'] = result
                if result.get('withdrawn') is True and result.get('id') == operation:
                    intent.update(state='withdrawn', withdrawnAtMs=t.now_ms())
                else:
                    intent['withdrawError'] = 'executor retained an existing receipt or resource'
            except (t.ExpertError, OSError, subprocess.TimeoutExpired) as error:
                intent['withdrawError'] = str(error)[:600]
            t.write_json(path, intent)


def reconcile_resources(t, root):
    retained = [x for x in records(t, root, 'task-dispatch')
                if x.get('resourceBinding') and not x.get('resourceReleased') and x.get('sessionId')]
    retained.sort(key=lambda x: x.get('resourceRetryAtMs', 0))
    limit = max(1, min(64, int(t.setting(root, 'TEAM_RESOURCE_CHECK_BATCH', 16))))
    for snapshot in retained[:limit]:
        operation = snapshot['operationId']
        with t.inbox_lock(root, operation, purpose='业务资源对账'):
            path = t.state_dir(root, 'task-dispatch', operation + '.json')
            intent = t.read_dispatch_record(path)
            if not intent or intent.get('resourceReleased'):
                continue
            intent['resourceRetryAtMs'] = t.now_ms()
            t.write_json(path, intent)
            pending = receipt(t, root, intent['sessionId'])
            if not pending or not pending.get('done'):
                continue
            try:
                release_local(t, root, dict(pending, operationId=operation, lock=intent.get('lock')))
            except (t.ExpertError, TeamConfigurationError, OSError, subprocess.TimeoutExpired) as error:
                intent['resourceRelease'] = dict(status='unknown', reason=str(error)[:300], checkedAtMs=t.now_ms())
                t.write_json(path, intent)
                t.record_system_issue(root, 'resource-release', str(error), operation)


def active_temp_creators(t, root):
    creators = set()
    for record in records(t, root, 'pending'):
        creators.update(x for x in (record.get('sessionId'), record.get('requester')) if x)
    for task in records(t, root, 'tasks'):
        if task.get('state') not in ('delivered', 'canceled'):
            creators.add((task.get('owner') or {}).get('sessionId'))
            creators.update(x['sessionId'] for x in task.get('collaborators', []))
            creators.update(x['sessionId'] for x in task.get('previousOwners', []))
    inbox = t.state_dir(root, 'inbox')
    if os.path.isdir(inbox):
        creators.update(x.split('.jsonl')[0] for x in os.listdir(inbox) if x.endswith(('.jsonl', '.jsonl.read')))
    projection_path = os.path.join(root, '.genethub', 'session-coordination.json')
    if os.path.exists(os.path.join(root, '.genethub', 'coordination-source.json')) and not os.path.exists(projection_path):
        raise t.ExpertError('协作摘要需要从持久记录重建', '没有清理可能仍在使用的材料', '恢复timer并核对引用')
    if os.path.exists(projection_path):
        projection = t.read_dispatch_record(projection_path)
        if not isinstance(projection, dict) or not isinstance(projection.get('sessions'), dict):
            raise t.ExpertError('临时材料引用摘要不可读', '没有自动清理材料', '恢复源端timer并核对任务引用')
        creators.update(sid for sid, row in projection['sessions'].items() if row.get('active') or row.get('pending') or row.get('ready') or row.get('unknown'))
        creators.update(projection.get('references') or [])
    return creators


def temp_is_referenced(t, root, path, creators=None):
    meta = t.read_json(os.path.join(path, '.temp.json'), {}) or {}
    creator = meta.get('creator')
    if meta.get('taskId'):
        local = t.read_dispatch_record(task_path(t, root, meta['taskId']))
        if local and local.get('state') not in ('delivered', 'canceled'):
            return True
        projection = t.read_dispatch_record(os.path.join(root, '.genethub', 'session-coordination.json'))
        if not local and (not projection or t.now_ms() - projection.get('updatedAtMs', 0) > 120_000):
            return True
    return bool(creator and creator in (active_temp_creators(t, root) if creators is None else creators))


def has_intent(t, root, requester):
    return any(x.get('state') in ('creating', 'prepared') and x.get('request', {}).get('requester') == requester
               for x in records(t, root, 'task-dispatch'))



def owner_sessions(t, root):
    return {(x.get('owner') or {}).get('sessionId') for x in records(t, root, 'tasks')}


def watchdog(t, root, task, pending):
    if task.get('state') != 'active' or task.get('finished') or not pending:
        return
    sid = (task.get('owner') or {}).get('sessionId')
    if not sid or pending.get('observedStatus') != 'idle' or pending.get('observedPaused') or pending.get('observedRequests') or pending.get('lastReconcileError') or t.now_ms() - pending.get('observedAtMs', 0) > 120_000:
        return
    if t._inbox_paths(root, sid) or has_intent(t, root, sid):
        return
    if any(x.get('requester') == sid for x in records(t, root, 'pending')):
        return
    now = t.now_ms()
    after = t.setting(root, 'TEAM_WATCHDOG_AFTER', t.WATCHDOG_AFTER_S) * 1000
    state = task.get('watchdog') or {}
    anchor = max(pending.get('observedActivityAtMs') or 0, pending.get('createdAtMs') or 0, state.get('lastWakeAtMs') or 0)
    if now - anchor < after:
        return
    progress = identity(json.dumps([(x['operationId'], x.get('finished')) for x in task.get('collaborators', [])], sort_keys=True))
    if state.get('progress') != progress:
        state = dict(progress=progress, wakes=0)
    maximum = int(t.setting(root, 'TEAM_WATCHDOG_MAX_WAKES', t.WATCHDOG_MAX_WAKES))
    if state.get('wakes', 0) >= maximum:
        if not state.get('reported'):
            t.record_system_issue(root, 'task-watchdog',
                                  '任务 %s 连续自动接力后仍无可核对进展，已停止自动唤醒，保留会话、材料和资源。' % task['taskId'], task['taskId'] + ':' + progress)
            state['reported'] = True
    else:
        state['wakes'] = state.get('wakes', 0) + 1
        state['lastWakeAtMs'] = now
        t.deliver_or_notice(root, sid, 'watchdog', 'task-watchdog',
                 '任务 %s 仍由你负责，当前没有未结算支持。检查实际目标和证据后继续；已完成请 task finish，阻塞请明确报告，不重做已有副作用。' % task['taskId'],
                 task['taskId'], str(state['wakes']), machine=(task.get('owner') or {}).get('machine'))
    with t.inbox_lock(root, task['taskId'], purpose='有界任务接力'):
        current = read_task(t, root, task['taskId'])
        if current['revision'] == task['revision']:
            current['watchdog'] = state
            t.write_json(task_path(t, root, task['taskId']), current)


def publish(t, root):
    with t.inbox_lock(root, 'projection', purpose='协作投影发布'):
        return _publish(t, root)


def _publish(t, root):
    """A single indexed snapshot of durable obligations; no remote history scans."""
    now = t.now_ms()
    projected = {}
    source = t.projection_source(root)
    def row(sid):
        if not sid or not t.SESSION_ID.fullmatch(sid):
            return None
        return projected.setdefault(sid, dict(source=source, taskId=None, active=False, pending=0, ready=0, unknown=0, updatedAtMs=now, stale=False))
    for record in records(t, root, 'pending'):
        own = row(record.get('sessionId'))
        if own is not None:
            own['active'] = True
            own['taskId'] = record.get('taskId')
        parent = row(record.get('requester'))
        if parent is not None:
            parent['active'] = True
            parent['ready' if record.get('done') else 'pending'] += 1
            parent['taskId'] = record.get('taskId') or parent['taskId']
            if record.get('lastReconcileError') or record.get('resumeAwaitingReceipt'):
                parent['unknown'] += 1
    for intent in records(t, root, 'task-dispatch'):
        if intent.get('state') in ('creating', 'prepared'):
            parent = row(intent.get('request', {}).get('requester'))
            if parent is not None:
                parent['active'] = True; parent['unknown'] += 1
    inbox_dir = t.state_dir(root, 'inbox')
    if os.path.isdir(inbox_dir):
        for name in os.listdir(inbox_dir):
            if name.endswith('.jsonl') or name.endswith('.jsonl.read'):
                sid = name.split('.jsonl')[0]
                messages = t._read_inbox(os.path.join(inbox_dir, name))
                own = row(sid)
                if own is not None and messages:
                    own['active'] = True
                    own['ready'] += len(messages)
    tasks = records(t, root, 'tasks')
    for task in tasks:
        if task.get('control') and not task['control'].get('complete'):
            try:
                reconcile_control(t, root, task)
                task = read_task(t, root, task['taskId'])
            except t.ExpertError:
                own = row((task.get('owner') or {}).get('sessionId'))
                if own is not None: own['active'] = True; own['unknown'] += 1
        owner = task.get('owner') or {}
        owner_pending = t.read_dispatch_record(t.state_dir(root, 'pending', owner.get('sessionId', '') + '.json')) if owner.get('sessionId') else None
        try:
            watchdog(t, root, task, owner_pending)
        except t.ExpertError:
            own = row(owner.get('sessionId'))
            if own is not None: own['active'] = True; own['unknown'] += 1
        if task.get('state') not in ('delivered', 'canceled'):
            done = t.read_dispatch_record(t.state_dir(root, 'done', owner.get('sessionId', '') + '.json')) if owner.get('sessionId') else None
            if done and done.get('taskId') == task['taskId'] and task.get('finished') and task['finished']['outcome'] != 'blocked':
                with t.inbox_lock(root, task['taskId'], purpose='任务交付'):
                    current = read_task(t, root, task['taskId'])
                    if current.get('revision') == task.get('revision'):
                        current['state'] = 'delivered'; t.write_json(task_path(t, root, task['taskId']), current)
            else:
                own = row(owner.get('sessionId'))
                if own is not None:
                    own['active'] = True; own['taskId'] = task['taskId']
    _, mine = t.me(root)
    # One local snapshot is shared by all local role Spaces. The immutable
    # relationships, not this replaceable file, survive projection loss.
    roots = [root] + [os.path.join(root, 'spaces', name) for name in mine.get('spaces', {}) if name != 'root']
    references = sorted({sid for task in tasks if task.get('state') not in ('delivered', 'canceled')
                         for sid in [(task.get('owner') or {}).get('sessionId')] + [x['sessionId'] for x in task.get('collaborators', [])] + [x['sessionId'] for x in task.get('previousOwners', [])] if sid})
    markers_path = t.state_dir(root, 'projection-targets.json')
    markers = t.read_dispatch_record(markers_path) or {}
    previous = t.read_json(os.path.join(root, '.genethub', 'session-coordination.json'), {}) or {}
    revision = max(markers.get('_revision', 0), previous.get('revision', 0)) + 1
    markers['_revision'] = revision
    # Counter survives deletion/corruption of the replaceable projection.
    t.write_json(markers_path, markers)
    snapshot = dict(version=1, source=source, revision=revision, receivedAtMs=now, updatedAtMs=now, sessions=projected, references=references)
    t.write_json(os.path.join(root, '.genethub', 'session-coordination.json'), snapshot)
    for target in roots:
        if os.path.isdir(target) and os.path.realpath(target) != os.path.realpath(root):
            t.write_json(os.path.join(target, '.genethub', 'coordination-source.json'), dict(version=1, source=source, projection='session-coordination.json'))
            with t.inbox_lock(target, 'projection', purpose='本地协作投影'):
                old = t.read_dispatch_record(os.path.join(target, '.genethub', 'session-coordination.json')) or {}
                if old.get('revision', 0) < revision:
                    t.write_json(os.path.join(target, '.genethub', 'session-coordination.json'), snapshot)
    # Changed projections or a one-minute heartbeat only, and only to bindings
    # with an actual task/pending execution. Empty views clear previous hints.
    remote_roles = {(x.get('machine'), x.get('kind')) for x in records(t, root, 'pending') if x.get('machine')}
    for task in tasks:
        owner = task.get('owner') or {}
        if owner.get('machine'): remote_roles.add((owner['machine'], owner.get('space')))
    bindings = t.remote_targets(root)
    content = identity(json.dumps(dict(sessions={sid: {k: v for k, v in row.items() if k != 'updatedAtMs'} for sid, row in projected.items()}, references=references), sort_keys=True))
    for role, target in bindings.items():
        key = identity(json.dumps(target, sort_keys=True))
        before = markers.get(key, {})
        if (target.get('machineId'), role) not in remote_roles and not before:
            continue
        if before.get('content') == content and 0 <= now - before.get('atMs', 0) < 60_000:
            continue
        try:
            t.remote_receive(target, dict(id=source, operation='coordination', workspaceId=target['workspaceId'], role=role, snapshot={k:v for k,v in snapshot.items() if k != 'receivedAtMs'}))
            markers[key] = dict(content=content, atMs=now)
        except t.ExpertError as error:
            markers[key] = dict(before, error=error.what)
    t.write_json(t.state_dir(root, 'projection-targets.json'), markers)
    return snapshot


def parser(sub):
    task = sub.add_parser('task', help='session-bound task ownership; timer reconciles durable relationships')
    actions = task.add_subparsers(dest='task_action', required=True)
    for action in ('start', 'support'):
        p = actions.add_parser(action)
        if action == 'support':
            p.add_argument('task_id')
            p.add_argument('--follows', help='operationId of this Team work item being redone')
            p.add_argument('--standing', action='store_true', help='standing support, excluded from finite-work latency and R2')
        p.add_argument('--space', required=True); p.add_argument('--desc', required=True)
        p.add_argument('--request-id', required=True); p.add_argument('--machine'); p.add_argument('--directory')
        p.add_argument('--tier'); p.add_argument('--model'); p.add_argument('--parameters', help='business JSON object; normally supplied by a project command'); p.add_argument('words', nargs='+')
    p = actions.add_parser('status'); p.add_argument('task_id')
    p = actions.add_parser('send'); p.add_argument('task_id'); p.add_argument('--request-id', required=True); p.add_argument('words', nargs='+')
    p = actions.add_parser('finish'); p.add_argument('task_id'); p.add_argument('--outcome', choices=('success', 'failed', 'blocked'), required=True); p.add_argument('words', nargs='+')
    for action in ('pause', 'resume', 'cancel', 'handover'):
        p = actions.add_parser(action); p.add_argument('task_id'); p.add_argument('--request-id', required=True); p.add_argument('--expected-revision', required=True, type=int)
        p.add_argument('--session'); p.add_argument('--machine'); p.add_argument('words', nargs='*')
    p = actions.add_parser('bind-directory'); p.add_argument('task_id'); p.add_argument('--directory', required=True)
