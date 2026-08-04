import type { AgentInfo } from "@genehub/proto";
import { useEffect, useState } from "react";

import { resolveAgentPresentation } from "./catalog/resolve";

export function AgentMark({
  agent,
  className = "h-5 w-5",
}: {
  agent: Pick<AgentInfo, "id" | "label">;
  className?: string;
}) {
  const presentation = resolveAgentPresentation(agent);
  const [failed, setFailed] = useState(false);
  const signature =
    presentation.kind === "icon" ? presentation.asset.default : presentation.kind;

  useEffect(() => setFailed(false), [signature]);

  if (presentation.kind === "text" || failed) {
    return (
      <span className="max-w-24 truncate text-xs font-medium text-fg" title={presentation.label}>
        {presentation.label}
      </span>
    );
  }
  if (presentation.kind === "glyph") {
    return (
      <span className="text-lg leading-none text-fg" aria-hidden>
        {presentation.glyph}
      </span>
    );
  }

  const frame = presentation.asset.surface === "light" ? "rounded bg-white p-0.5" : "";
  const themed = Boolean(presentation.asset.light);
  return (
    <span className={`relative block shrink-0 overflow-hidden ${className} ${frame}`} aria-hidden>
      <img
        src={presentation.asset.dark ?? presentation.asset.default}
        alt=""
        className={`${themed ? "agent-brand-dark " : ""}h-full w-full object-contain`}
        onError={() => setFailed(true)}
      />
      {presentation.asset.light ? (
        <img
          src={presentation.asset.light}
          alt=""
          className="agent-brand-light absolute inset-0 hidden h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
