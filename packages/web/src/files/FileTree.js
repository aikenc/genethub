import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
/**
 * The project tree.
 *
 * Children arrive lazily: `children` being absent means "not expanded yet",
 * which is a different thing from an empty directory, and conflating the two
 * would make every empty folder look like a loading bug.
 */
export function FileTree({ root, selected, onOpen, onExpand, }) {
    return (_jsx("ul", { className: "select-none text-sm", role: "tree", "aria-label": "\u6587\u4EF6\u6811", children: (root.children ?? []).map((child) => (_jsx(Node, { node: child, depth: 0, selected: selected ?? null, onOpen: onOpen, onExpand: onExpand }, child.path))) }));
}
function Node({ node, depth, selected, onOpen, onExpand, }) {
    const [open, setOpen] = useState(false);
    const children = node.children;
    return (_jsxs("li", { role: "none", children: [_jsxs("button", { type: "button", role: "treeitem", "aria-expanded": node.isDir ? open : undefined, "aria-selected": selected === node.path, className: `flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left hover:bg-raised ${selected === node.path ? "bg-raised" : ""}`, style: { paddingLeft: `${depth * 12 + 8}px` }, onClick: () => {
                    if (!node.isDir) {
                        onOpen(node.path);
                        return;
                    }
                    const next = !open;
                    setOpen(next);
                    if (next && children === undefined)
                        onExpand(node.path);
                }, children: [_jsx("span", { className: "w-3 shrink-0 text-muted", children: node.isDir ? (open ? "▾" : "▸") : "" }), _jsx("span", { className: "truncate", children: node.name })] }), node.isDir && open ? (children === undefined ? (_jsx("p", { className: "py-1 pl-8 text-xs text-muted", children: "\u8F7D\u5165\u4E2D\u2026" })) : (_jsx("ul", { role: "group", children: children.map((child) => (_jsx(Node, { node: child, depth: depth + 1, selected: selected, onOpen: onOpen, onExpand: onExpand }, child.path))) }))) : null] }));
}
