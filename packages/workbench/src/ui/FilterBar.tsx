import { useEffect, useRef, type ReactNode } from "react";

/** Filters describe one list. Actions never compete with labels for width. */
export function FilterBar<T extends string>({ label, options, value, onChange, actions, navigation = false }: {
  label: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange(value: T): void;
  actions?: ReactNode;
  /** Page destinations use current-page semantics, list filters use pressed. */
  navigation?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="page"]');
    if (!selected || !strip.current) return;
    const parent = strip.current.getBoundingClientRect();
    const child = selected.getBoundingClientRect();
    // Scroll only this strip: scrollIntoView can move the surrounding page.
    if (child.left < parent.left) strip.current.scrollLeft -= parent.left - child.left;
    else if (child.right > parent.right) strip.current.scrollLeft += child.right - parent.right;
  }, [value]);
  return <div aria-label={label} className="gh-filter-bar">
    <div ref={strip} className="gh-filter-options">
      {options.map(([id, text]) => <button key={id} type="button" aria-pressed={navigation ? undefined : value === id}
        aria-current={navigation && value === id ? "page" : undefined}
        className="gh-filter-option" onClick={() => onChange(id)}>{text}</button>)}
    </div>
    {actions && <div className="gh-filter-actions">{actions}</div>}
  </div>;
}
