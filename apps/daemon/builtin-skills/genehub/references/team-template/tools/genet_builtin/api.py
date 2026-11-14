"""Stable public Team classes. Built-ins are defaults, not an OS permission boundary.

Override business decisions instead of copying task/recovery internals. Constructors
are side-effect free; all durable task and resource mutations belong to the runtime.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

API_VERSION = 1


class TeamConfigurationError(ValueError):
    """A configured Class, settings, binding or decision cannot be verified."""


@dataclass(frozen=True)
class Decision:
    status: str
    reason: str = ""

    def __post_init__(self):
        if self.status not in ("allow", "hold", "unknown"):
            raise TeamConfigurationError("decision must be allow, hold or unknown")
        if self.status != "allow" and not self.reason:
            raise TeamConfigurationError("a blocked/unknown decision needs a reason")

    @property
    def allowed(self):
        return self.status == "allow"

    @classmethod
    def allow(cls, reason=""):
        return cls("allow", reason)

    @classmethod
    def hold(cls, reason):
        return cls("hold", reason)

    @classmethod
    def unknown(cls, reason):
        return cls("unknown", reason)


ReleaseDecision = Decision


@dataclass(frozen=True)
class TaskContext:
    team_root: str
    session_id: str | None = None
    operation_id: str = ""


@dataclass(frozen=True)
class TaskRequest:
    role: str
    goal: str
    requester: str
    task_id: str
    machine: str | None = None
    directory: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ResourcePlan:
    directory: str
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ResourceBinding:
    task_id: str
    operation_id: str
    directory: str
    parameters: dict[str, Any] = field(default_factory=dict)
    preparation: dict[str, Any] = field(default_factory=dict)
    session_id: str | None = None


class Policy:
    api_version = API_VERSION
    binding_version = 1

    def __init__(self, context, settings=None):
        if settings is None:
            settings = {}
        if not isinstance(settings, dict):
            raise TeamConfigurationError("policy settings must be an object")
        self.context = context
        self.settings = settings


class WorkflowPolicy(Policy):
    def check_request(self, context, request):
        return Decision.allow()

    def check_completion(self, context, task):
        return Decision.allow()


class ResourcePolicy(Policy):
    def plan_resource(self, context, request):
        return ResourcePlan(request.directory) if request.directory else None

    def prepare_resource(self, context, binding):
        return {}

    def check_release(self, context, binding):
        return Decision.allow()


class ReflectionPolicy(Policy):
    def evaluate(self, context, snapshot):
        return Decision.allow(snapshot["reason"]) if snapshot.get("reason") else Decision.hold("no reflection due")


class BoardPresenter(Policy):
    def sections(self, context, snapshot):
        return []


class TeamCommands(Policy):
    def register(self, subparsers, services):
        """Register business commands and return {command: handler(args)}.

        Do not execute business here. task/tick/describe and other existing
        framework commands are reserved; handlers use services for task actions.
        """
        return {}


class TeamMode(Policy):
    workflow_class = WorkflowPolicy
    resource_class = ResourcePolicy
    reflection_class = ReflectionPolicy
    board_class = BoardPresenter
    commands_class = TeamCommands


class TaskService:
    """Public command facade over the same task ledger and reliable dispatcher."""
    def __init__(self, team_root):
        self.team_root = team_root

    def _command(self, action, **values):
        import contextlib
        import io
        import json
        from types import SimpleNamespace
        from . import team, tasks
        defaults = dict(task_action=action, request_id=None, task_id=None, space=None,
                        desc="", words=[], machine=None, directory=None, tier=None,
                        model=None, parameters={}, outcome=None, expected_revision=None, session=None)
        defaults.update(values)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            tasks.command(team, SimpleNamespace(**defaults), root=self.team_root)
        lines = output.getvalue().strip().splitlines()
        return json.loads(lines[-1]) if lines else None

    def start(self, *, request_id, role, goal, description="", directory=None,
              machine=None, parameters=None, tier=None, model=None):
        return self._command("start", request_id=request_id, space=role,
                             desc=description or goal[:80], words=[goal], directory=directory,
                             machine=machine, parameters=parameters or {}, tier=tier, model=model)

    def support(self, task_id, *, request_id, role, goal, directory=None,
                machine=None, parameters=None, tier=None, model=None):
        return self._command("support", task_id=task_id, request_id=request_id,
                             space=role, desc=goal[:80], words=[goal], directory=directory,
                             machine=machine, parameters=parameters or {}, tier=tier, model=model)

    def status(self, task_id, *, summary=False):
        return self._command("status", task_id=task_id, summary=summary)

    def send(self, task_id, *, request_id, text):
        return self._command("send", task_id=task_id, request_id=request_id, words=[text])

    def finish(self, task_id, *, outcome, evidence):
        return self._command("finish", task_id=task_id, outcome=outcome, words=[evidence])

    def control(self, task_id, *, action, request_id, expected_revision, text="", session=None):
        if action not in ("pause", "resume", "cancel", "handover"):
            raise TeamConfigurationError("unknown task control")
        return self._command(action, task_id=task_id, request_id=request_id,
                             expected_revision=expected_revision, words=[text] if text else [], session=session)
