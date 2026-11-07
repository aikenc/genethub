import { type ReactNode } from "react";

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
  return <div aria-label={label} className="gh-filter-bar">
    <div className="gh-filter-options">
      {options.map(([id, text]) => <button key={id} type="button" aria-pressed={navigation ? undefined : value === id}
        aria-current={navigation && value === id ? "page" : undefined}
        className="gh-filter-option" onClick={() => onChange(id)}>{text}</button>)}
    </div>
    {actions && <div className="gh-filter-actions">{actions}</div>}
  </div>;
}
