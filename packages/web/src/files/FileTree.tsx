import type { FileNode } from "@genehub/proto";
import { useEffect, useState } from "react";

/**
 * The project tree.
 *
 * Children arrive lazily: `children` being absent means "not expanded yet",
 * which is a different thing from an empty directory, and conflating the two
 * would make every empty folder look like a loading bug.
 *
 * In `selecting` mode, row clicks toggle membership instead of opening a file,
 * so copy/cut/delete never race the Preview float.
 */
export function FileTree({
  root,
  selected,
  checked,
  selecting = false,
  onOpen,
  onExpand,
  onActivate,
  onToggle,
}: {
  root: FileNode;
  selected?: string | null;
  checked?: ReadonlySet<string>;
  selecting?: boolean;
  onOpen(path: string): void;
  onExpand(path: string): void;
  /** Normal-mode focus for paste / new-folder targets (folders and files). */
  onActivate?(path: string, node: FileNode): void;
  onToggle?(path: string): void;
}) {
  return (
    <ul className="select-none text-sm" role="tree" aria-label="文件树">
      {(root.children ?? []).map((child) => (
        <Node
          key={child.path}
          node={child}
          depth={0}
          selected={selected ?? null}
          checked={checked}
          selecting={selecting}
          onOpen={onOpen}
          onExpand={onExpand}
          onActivate={onActivate}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function Node({
  node,
  depth,
  selected,
  checked,
  selecting,
  onOpen,
  onExpand,
  onActivate,
  onToggle,
}: {
  node: FileNode;
  depth: number;
  selected: string | null;
  checked?: ReadonlySet<string>;
  selecting: boolean;
  onOpen(path: string): void;
  onExpand(path: string): void;
  onActivate?(path: string, node: FileNode): void;
  onToggle?(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  // Older daemons serialized Rust None as JSON null even though the generated
  // TypeScript contract said this optional field was absent. Normalize both:
  // attempting null.map() here used to unmount the complete React workbench.
  const children = node.children ?? undefined;
  const isChecked = checked?.has(node.path) ?? false;
  const highlighted = selecting ? isChecked : selected === node.path;

  // A root refresh intentionally replaces its shallow listing. Nodes keep
  // their React key (and therefore their open state), then refill their own
  // subtree. Without this an open folder became an endless "载入中" row after
  // refresh because expansion was only requested from the click handler.
  useEffect(() => {
    if (node.isDir && open && children === undefined) onExpand(node.path);
  }, [children, node.isDir, node.path, onExpand, open]);

  return (
    <li role="none">
      <div
        className={`flex w-full items-center gap-1 truncate rounded pr-2 text-left hover:bg-raised ${
          highlighted ? "bg-raised" : ""
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <button
          type="button"
          className="flex h-7 w-5 shrink-0 items-center justify-center text-muted"
          aria-label={node.isDir ? (open ? `折叠 ${node.name}` : `展开 ${node.name}`) : undefined}
          aria-hidden={!node.isDir}
          tabIndex={node.isDir ? 0 : -1}
          disabled={!node.isDir}
          onClick={(event) => {
            event.stopPropagation();
            if (!node.isDir) return;
            const next = !open;
            setOpen(next);
            if (next) onExpand(node.path);
          }}
        >
          {node.isDir ? (open ? "▾" : "▸") : ""}
        </button>
        <button
          type="button"
          role="treeitem"
          aria-expanded={node.isDir ? open : undefined}
          aria-selected={highlighted}
          aria-checked={selecting ? isChecked : undefined}
          className="flex min-w-0 flex-1 items-center gap-1 truncate py-1 text-left"
          onClick={() => {
            if (selecting) {
              onToggle?.(node.path);
              return;
            }
            onActivate?.(node.path, node);
            if (!node.isDir) {
              onOpen(node.path);
              return;
            }
            const next = !open;
            setOpen(next);
            if (next) onExpand(node.path);
          }}
        >
          {selecting ? (
            <span
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                isChecked
                  ? "border-accent bg-accent text-white"
                  : "border-line-strong text-transparent"
              }`}
              aria-hidden
            >
              ✓
            </span>
          ) : null}
          <span className="truncate">{node.name}</span>
        </button>
      </div>

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
                checked={checked}
                selecting={selecting}
                onOpen={onOpen}
                onExpand={onExpand}
                onActivate={onActivate}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}
