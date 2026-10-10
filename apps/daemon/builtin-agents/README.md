# GeneHub script Agents

Every third-party Agent GeneHub can drive is a directory here. The daemon
knows nothing about any of them: it starts `agent.py serve` with its own
Python and talks the protocol in `docs/agent-serve-protocol.md`.

```
builtin/<id>/   shipped with GeneHub; rewritten on every start — do not edit
user/<id>/      yours: a new Agent, or a copy of builtin/<id> that replaces it
state/<id>/     the Agent's own state (caches, install prefix); kept on reset
sdk/            boot.py and the genehub_agent package
runtime/        the Python install scripts and the Python they installed
```

## Change an existing Agent

1. `cp -r builtin/<id> user/<id>` (once).
2. Edit `user/<id>/`. `README.md` inside each Agent explains its files.
3. `"$GENEHUB_CLI" agent test <id>` — offline checks; add `--live` to also
   probe the real CLI.
4. `"$GENEHUB_CLI" agent reload <id>` — the only way an edit takes effect.
   An invalid `agent.toml` is reported and the running version stays.
5. `"$GENEHUB_CLI" agent logs <id>` shows what the script wrote to stderr.

`"$GENEHUB_CLI" agent reset <id>` deletes `user/<id>` and goes back to the
built-in. An override that keeps crashing is set aside automatically until the
next reload.

## Add a new Agent

Create `user/<id>/` (`^[a-z][a-z0-9-]{1,31}$`) with:

```toml
# agent.toml
protocol = 1
label    = "My Agent"
entry    = "agent.py"
```

```python
# agent.py
from genehub_agent import Agent, Session, serve, events

class MySession(Session):
    async def send(self, turn_id, text, attachments):
        self.ctx.emit(events.item(turn_id, events.assistant_message(turn_id + "-1", "hi")))
        self.ctx.emit(events.turn_completed(turn_id))

class MyAgent(Agent):
    async def refresh(self, ctx):
        ctx.set_state(ready=True, message="ready")

    async def open_session(self, ctx):
        return MySession(ctx)

serve(MyAgent())
```

then `"$GENEHUB_CLI" agent reload <id>`. The built-in `codex` (JSON-RPC
app-server) and `cursor` (print mode + stream-json) are complete examples of
install, login, catalog, sessions and import.

## Rules the daemon enforces

- Only `ready: true` Agents can be chosen. Otherwise the action marked
  `primary` is offered next to `message`.
- `ctx.request(...)` is answered only by a person in the workbench. Its
  contents never reach a model, a timeline or a log; never print them.
- The daemon emits `turnStarted`; a session emits exactly one of
  `turnCompleted` / `turnFailed` / `turnCanceled` per turn.
- Every request has a deadline. Missing it, exiting or breaking the pipe
  restarts the process, and live sessions are started again with the last
  value given to `ctx.set_persist`.
- Standard library only. The interpreter runs isolated (`-I`); nothing from the
  user's Python, site-packages or `PYTHON*` variables is visible, and this
  Python is never put on the `PATH` of the CLIs an Agent starts.
