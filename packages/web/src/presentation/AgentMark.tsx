import type { AgentInfo } from "@genehub/proto";
import { useEffect, useState } from "react";

import { resolveAgentPresentation } from "./catalog/resolve";

export function AgentMark({
  agent,
  className = "h-5 w-5",
  textClassName = "max-w-24 text-xs",
  glyphClassName = "text-lg",
  fallbackToText = true,
}: {
  agent: Pick<AgentInfo, "id" | "label">;
  className?: string;
  textClassName?: string;
  glyphClassName?: string;
  /** A surrounding card may already render the name beside the mark. */
  fallbackToText?: boolean;
}) {
  const presentation = resolveAgentPresentation(agent);
  const [failed, setFailed] = useState(false);
  const signature =
    presentation.kind === "icon" ? presentation.asset.default : presentation.kind;

  useEffect(() => setFailed(false), [signature]);

  if (presentation.kind === "text" || failed) {
    if (fallbackToText) {
      return (
        <span className={`${textClassName} truncate font-medium text-fg`} title={presentation.label}>
          {presentation.label}
        </span>
      );
    }
    return <Monogram label={presentation.label} className={className} />;
  }
  if (presentation.kind === "glyph") {
    return (
      <span className={`${glyphClassName} leading-none text-fg`} aria-hidden>
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

/**
 * The Agent's initial, for the ones this build has no mark for.
 *
 * Codex, Copilot, Gemini and every locally configured ACP Agent have no
 * bundled icon — their vendors' marks are trademarks we do not redistribute —
 * and in a row of tabs that showed as an empty gap where the others have a
 * logo. A letter is not a brand and does not claim to be one; it just keeps
 * the row aligned and gives the Agent a constant place to look.
 */
function Monogram({ label, className }: { label: string; className: string }) {
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded bg-raised text-[10px] font-semibold uppercase leading-none text-muted`}
    >
      {[...label][0] ?? "?"}
    </span>
  );
}
