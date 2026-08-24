import {
  Activity,
  Folder,
  Laptop,
  Monitor,
  ScrollText,
  Settings,
  SquareTerminal,
} from "lucide-react";

import type { TabKind } from "../session/store";

/**
 * Marks a built-in work surface so it does not read as another chat.
 *
 * Chat tabs already carry a session status. Files, settings and the rest
 * used to be a bare title in the same strip, which made a settings page
 * look like an agent conversation until you opened it.
 */
export function TabKindIcon({ kind }: { kind: TabKind | undefined }) {
  if (!kind || kind === "chat") return null;
  const Icon = iconFor(kind);
  return (
    <Icon
      data-testid={`tab-icon-${kind}`}
      className="h-3.5 w-3.5 shrink-0 text-muted"
      aria-hidden
    />
  );
}

function iconFor(kind: TabKind) {
  if (kind === "files") return Folder;
  if (kind === "terminal") return SquareTerminal;
  if (kind === "settings") return Settings;
  if (kind === "devices") return Monitor;
  if (kind === "logs") return ScrollText;
  if (kind === "processes") return Activity;
  return Laptop;
}
