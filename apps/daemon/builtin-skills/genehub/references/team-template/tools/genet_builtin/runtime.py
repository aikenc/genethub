"""One configured Class factory per Team invocation; no second scheduler/state store."""
import copy
import hashlib
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import sys

from .api import (API_VERSION, BoardPresenter, Decision, ReflectionPolicy, ResourcePolicy,
                  TaskContext, TaskService, TeamCommands, TeamConfigurationError,
                  TeamMode, WorkflowPolicy)

SLOTS = {"workflow_class": (WorkflowPolicy, "workflow"),
         "resource_class": (ResourcePolicy, "resource"),
         "reflection_class": (ReflectionPolicy, "reflection"),
         "board_class": (BoardPresenter, "board"),
         "commands_class": (TeamCommands, "commands")}
_CLASS_REF = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", re.ASCII)
_CACHE = {}


def json_value(value):
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError) as error:
        raise TeamConfigurationError("business data must be finite JSON") from error
    if len(encoded.encode()) > 128 * 1024:
        raise TeamConfigurationError("business data exceeds 128 KiB")
    return json.loads(encoded)


def verify_output_artifact(root, exact=False):
    """Runtime package verification; exact mode rejects unowned author inputs."""
    root = Path(root).resolve()
    receipt = root / '.spacebuilder/output-lock.json'
    if receipt.is_symlink(): raise TeamConfigurationError('output receipt is a symlink')
    try:
        value = json.loads(receipt.read_text(encoding='utf-8'))
        if value.get('schema') != 'spacebuilder-output.v1' or not isinstance(value.get('artifacts'), list):
            raise ValueError('invalid output receipt')
        files = {'.spacebuilder/output-lock.json'}
        members = {item['path'] for item in value['members']}
        if '.' not in members: raise ValueError('root member missing')
        for item in value['artifacts']:
            if item['member'] not in members: raise ValueError('unknown output member')
            relative = Path(item['member']) / item['target']
            if relative.is_absolute() or '..' in relative.parts: raise ValueError('escaping output path')
            path = root / relative
            if any(part.is_symlink() for part in [path, *list(path.parents)[:len(relative.parts)-1]]):
                raise ValueError('symlink in output path')
            name = relative.as_posix()
            if name in files: raise ValueError('duplicate output path')
            if not path.is_file() or 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest() != item['digest'] or bool(path.stat().st_mode & 0o100) != item['executable']:
                raise ValueError('missing/changed artifact: '+name)
            if item['logicalType'] == 'runtime-manifest':
                descriptor = json.loads(path.read_text(encoding='utf-8'))
                if any(descriptor.get(key) for key in ('identity','skillProviders','buildHooks')):
                    raise ValueError('author inputs in execution descriptor')
            files.add(name)
        if not {'agent-space.genet.json','tools/run.py'} <= files:
            raise ValueError('complete Team runtime missing')
        if exact:
            for path in root.rglob('*'):
                if path.is_symlink() or path.is_file() and path.relative_to(root).as_posix() not in files | {'.spacebuilder/build.lock'}:
                    raise ValueError('unowned input in artifact: '+str(path.relative_to(root)))
        return files
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise TeamConfigurationError('Team artifact integrity failed: '+str(error)) from error


def class_ref(cls):
    # Public defaults retain their stable API module identity.
    return cls.__module__ + ":" + cls.__qualname__


def resolve_class(reference, expected, root):
    if not isinstance(reference, str) or not _CLASS_REF.fullmatch(reference):
        raise TeamConfigurationError("Class must be an explicit module:Class reference")
    module_name, name = reference.split(":")
    tools = str(Path(root) / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    try:
        module = importlib.import_module(module_name)
        cls = getattr(module, name)
    except (ImportError, AttributeError, OSError) as error:
        raise TeamConfigurationError("cannot load configured Class " + reference) from error
    if not isinstance(cls, type) or not issubclass(cls, expected):
        raise TeamConfigurationError(reference + " must inherit " + expected.__name__)
    if type(cls.api_version) is not int or cls.api_version != API_VERSION:
        raise TeamConfigurationError(reference + " uses an incompatible Team API")
    if not isinstance(cls.binding_version, int) or isinstance(cls.binding_version, bool) or cls.binding_version < 1:
        raise TeamConfigurationError(reference + " has an invalid binding_version")
    if not module_name.startswith("genet_builtin."):
        source = Path(inspect.getfile(cls)).resolve()
        if os.path.commonpath([str(source), str(Path(tools).resolve())]) != str(Path(tools).resolve()):
            raise TeamConfigurationError("configured Class comes from another Team: " + reference)
    return cls


def check_decision(value):
    if not isinstance(value, Decision):
        raise TeamConfigurationError("policy must return Decision, not bool/None")
    return value


class TeamRuntime:
    def __init__(self, root):
        self.root = str(Path(root).resolve())
        self.verify_artifact()
        path = Path(self.root) / "agent-space.genet.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise TeamConfigurationError("cannot read Team descriptor") from error
        self.config = raw.get("team", {})
        if not isinstance(self.config, dict):
            raise TeamConfigurationError("descriptor.team must be an object")
        extra = set(self.config) - {"class", "settings", "apiVersion", "frameworkVersion", *SLOTS}
        if extra:
            raise TeamConfigurationError("unknown team settings: " + ", ".join(sorted(extra)))
        if type(self.config.get("apiVersion", API_VERSION)) is not int or self.config.get("apiVersion", API_VERSION) != API_VERSION:
            raise TeamConfigurationError("incompatible Team API version")
        if self.config.get("frameworkVersion", "1") != "1":
            raise TeamConfigurationError("requested Team framework version is unavailable")
        settings = self.config.get("settings", {})
        if not isinstance(settings, dict) or any(not isinstance(v, dict) for v in settings.values()):
            raise TeamConfigurationError("team.settings must be an object")
        settings = json_value(settings)
        self.context = TaskContext(self.root, os.environ.get("GENEHUB_SESSION_ID"))
        reference = self.config.get("class", "genet_builtin.api:TeamMode")
        cls = resolve_class(reference, TeamMode, self.root)
        self.mode = cls(self.context, copy.deepcopy(settings))
        self.classes = {"class": reference}
        self.sources = {"class": "descriptor" if "class" in self.config else "default"}
        self.versions = {"class": cls.binding_version}
        for slot, (base, component) in SLOTS.items():
            if slot in self.config:
                selected = self.config[slot]
            else:
                default = getattr(self.mode, slot)
                if not isinstance(default, type):
                    raise TeamConfigurationError("TeamMode." + slot + " must be a policy Class")
                selected = class_ref(default)
            policy = resolve_class(selected, base, self.root)
            values = settings.get(component, {})
            if not isinstance(values, dict):
                raise TeamConfigurationError("settings." + component + " must be an object")
            setattr(self, component, policy(self.context, copy.deepcopy(values)))
            self.classes[slot] = selected
            self.sources[slot] = "descriptor" if slot in self.config else "mode"
            self.versions[slot] = policy.binding_version
        self.tasks = TaskService(self.root)

    def verify_artifact(self):
        """Reject partially installed code before loading business modules.

        This is package integrity, not a sandbox. Intentional edits are made in
        the source and rebuilt; the output ownership receipt is generated.
        """
        receipt = Path(self.root) / ".spacebuilder/output-lock.json"
        if not receipt.exists():
            return
        verify_output_artifact(self.root)

    def for_operation(self, operation_id):
        return TaskContext(self.root, self.context.session_id, operation_id)

    def identity(self):
        return dict(apiVersion=API_VERSION, classes=self.classes, bindingVersions=self.versions,
                    settingsSha256=hashlib.sha256(json.dumps(self.config.get("settings", {}), sort_keys=True).encode()).hexdigest())

    def verify_task(self, task):
        old = task.get("framework")
        if old and old != self.identity():
            raise TeamConfigurationError("task belongs to another Class/binding version; retain its original deployment to finish")
        if not old and task.get("owner") and any(k not in ("apiVersion", "frameworkVersion") for k in self.config):
            raise TeamConfigurationError("legacy task has no Class binding; finish with its original framework before adopting custom policies")

    def describe(self):
        hashes = {}
        for slot, reference in self.classes.items():
            base = TeamMode if slot == "class" else SLOTS[slot][0]
            cls = resolve_class(reference, base, self.root)
            source = Path(inspect.getfile(cls))
            hashes[slot] = hashlib.sha256(source.read_bytes()).hexdigest()
        return dict(apiVersion=API_VERSION, classes=self.classes, sources=self.sources,
                    bindingVersions=self.versions, classSourceSha256=hashes,
                    configuration="agent-space.genet.json#team", entry="tools/run.py")


def get_runtime(root):
    key = str(Path(root).resolve())
    if key not in _CACHE:
        _CACHE[key] = TeamRuntime(key)
    return _CACHE[key]
