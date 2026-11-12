"""Business resource policy around the existing writer lease, not another lock store."""
from dataclasses import asdict
import os

from .api import ResourcePlan, ResourceBinding, ResourcePolicy, TaskRequest, TeamConfigurationError
from .runtime import get_runtime, json_value, check_decision


def request(task_id, role, goal, requester, machine, directory, parameters):
    return TaskRequest(role, goal, requester, task_id, machine, directory, json_value(parameters or {}))


def gate(runtime, req, operation):
    decision = check_decision(runtime.workflow.check_request(runtime.for_operation(operation), req))
    if not decision.allowed:
        raise TeamConfigurationError("workflow " + decision.status + ": " + decision.reason)


def prepare(t, root, intent, req, path):
    runtime = get_runtime(root)
    context = runtime.for_operation(intent['operationId'])
    if req.machine and type(runtime.resource) is not ResourcePolicy:
        raise TeamConfigurationError("custom resource preparation must run in its installed execution Team; no source-side remote path guesses")
    if req.machine:
        # Executor paths belong to its OS and exact receive receipt. Never
        # resolve or claim them on the source, even on a same-host test setup.
        intent.setdefault('resourcePlan', None)
        t.write_json(path, intent)
        return None
    if 'resourcePlan' not in intent:
        plan = runtime.resource.plan_resource(context, req)
        if plan is not None and not isinstance(plan, ResourcePlan):
            raise TeamConfigurationError("resource.plan_resource must return ResourcePlan or None")
        if plan is not None:
            if not isinstance(plan.directory, str) or not plan.directory:
                raise TeamConfigurationError("ResourcePlan.directory must be nonempty")
            if not isinstance(plan.parameters, dict):
                raise TeamConfigurationError("ResourcePlan.parameters must be a JSON object")
            plan = ResourcePlan(t.resolve_expert_dir(root, plan.directory), json_value(plan.parameters))
        intent['resourcePlan'] = asdict(plan) if plan else None
        t.write_json(path, intent)
    plan = intent['resourcePlan']
    if plan is None:
        return None
    directory = plan['directory']
    if not os.path.isdir(directory):
        raise TeamConfigurationError("resource directory must exist before claiming: " + directory)
    with t.inbox_lock(t.writer_lock(directory), 'writer', purpose='业务工位认领'):
        lock, won = t.claim(directory, dict(session=intent.get('sessionId'), requestId=intent['operationId'], at=t.now_ms()), 'genet-writer.json')
        holder = t.read_json(lock, {}) or {}
        if not won and holder.get('requestId') != intent['operationId']:
            raise TeamConfigurationError("resource is occupied; original writer retained")
        intent['lock'] = lock
        binding = ResourceBinding(req.task_id, intent['operationId'], directory, plan['parameters'],
                                  (intent.get('resourceBinding') or {}).get('preparation', {}), intent.get('sessionId'))
        intent['resourceBinding'] = asdict(binding)
        t.write_json(path, intent)  # durable intent and lease BEFORE business preparation
        if not intent.get('resourcePrepared'):
            # This hook MUST be idempotent by operation_id; interrupted/unknown
            # preparation retains this exact lease and retries the same identity.
            values = json_value(runtime.resource.prepare_resource(context, binding))
            if not isinstance(values, dict):
                raise TeamConfigurationError("resource.prepare_resource must return a JSON object")
            intent['resourceBinding']['preparation'] = values
            intent['resourcePrepared'] = True
            t.write_json(path, intent)
    return directory


def release_decision(root, intent):
    runtime = get_runtime(root)
    binding = ResourceBinding(**intent['resourceBinding'])
    return check_decision(runtime.resource.check_release(runtime.for_operation(binding.operation_id), binding))
