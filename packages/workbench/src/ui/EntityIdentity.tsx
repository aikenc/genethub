import type { ReactNode } from "react";
import { AgentAvatar } from "../workspace/AgentAvatar";

/** Identity geometry is identical in expert, conversation and picker rows. */
export function EntityAvatar({id, name, badge}: {id: string; name: string; badge?: ReactNode}) {
  return <span className="relative shrink-0"><AgentAvatar id={id} name={name}/>{badge && <span className="absolute -top-1 -right-1 rounded-full bg-sidebar p-0.5">{badge}</span>}</span>;
}
export function EntityText({title, children, hint}: {title: string; children: ReactNode; hint?: string}) {
  return <span className="entity-copy min-w-0 flex-1">
    <span className="entity-title block truncate text-sm font-medium leading-6 text-fg">{title}</span>
    <span className="entity-secondary flex min-w-0 items-center gap-1 text-xs font-normal leading-5 text-muted" title={hint}>{children}</span>
  </span>;
}
