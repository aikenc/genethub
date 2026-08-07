import type { FileNode } from "@genehub/proto";
import { useEffect, useState } from "react";

/**
 * The project tree.
 *
 * Children arrive lazily: `children` being absent means "not expanded yet",
 * which is a different thing from an empty directory, and conflating the two
 * would make every empty folder look like a loading bug.
 */
export function FileTree({
  root,
  selected,
  onOpen,
  onExpand,
}: {
  root: FileNode;
  selected?: string | null;
  onOpen(path: string): void;
  onExpand(path: string): void;
}) {
  return (
    <ul className="select-none text-sm" role="tree" aria-label="文件树">
      {(root.children ?? []).map((child) => (
        <Node
          key={child.path}
          node={child}
          depth={0}
          selected={selected ?? null}
          onOpen={onOpen}
          onExpand={onExpand}
        />
      ))}
    </ul>
  );
}

function Node({
  node,
  depth,
  selected,
  onOpen,
  onExpand,
}: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onOpen(path: string): void;
  onExpand(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  const children = node.children;

  // A root refresh intentionally replaces its shallow listing. Nodes keep
  // their React key (and therefore their open state), then refill their own
  // subtree. Without this an open folder became an endless "载入中" row after
  // refresh because expansion was only requested from the click handler.
  useEffect(() => {
    if (node.isDir && open && children === undefined) onExpand(node.path);
  }, [children, node.isDir, node.path, onExpand, open]);

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={node.isDir ? open : undefined}
        aria-selected={selected === node.path}
        className={`flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left hover:bg-raised ${
          selected === node.path ? "bg-raised" : ""
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (!node.isDir) {
            onOpen(node.path);
            return;
          }
          const next = !open;
          setOpen(next);
        }}
      >
        <span className="w-3 shrink-0 text-muted">{node.isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className="truncate">{node.name}</span>
      </button>

      {node.isDir && open ? (
        children === undefined ? (
          <p className="py-1 pl-8 text-xs text-muted">载入中…</p>
        ) : (
          <ul role="group">
            {children.map((child) => (
              <Node
                key={child.path}
                node={child}
                depth={depth + 1}
                selected={selected}
                onOpen={onOpen}
                onExpand={onExpand}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}
