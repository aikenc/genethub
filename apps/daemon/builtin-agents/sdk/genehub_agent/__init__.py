"""GeneHub Agent SDK: everything a script Agent needs to talk to the daemon.

    from genehub_agent import Agent, Session, serve

    class MyAgent(Agent):
        async def refresh(self, ctx):
            ctx.set_state(ready=True, message="ready")

    serve(MyAgent())

See ``docs/agent-serve-protocol.md`` for the wire protocol and the README in
the agents directory for how to write or modify an Agent.
"""

from . import events
from .serve import (
    Agent,
    AgentContext,
    Job,
    Outcome,
    Platform,
    RequestHandle,
    Session,
    SessionConfig,
    SessionContext,
    choice_question,
    code,
    link,
    option,
    secret_question,
    serve,
    text_question,
)

__all__ = [
    "Agent",
    "AgentContext",
    "Job",
    "Outcome",
    "Platform",
    "RequestHandle",
    "Session",
    "SessionConfig",
    "SessionContext",
    "choice_question",
    "code",
    "events",
    "link",
    "option",
    "secret_question",
    "serve",
    "text_question",
]
