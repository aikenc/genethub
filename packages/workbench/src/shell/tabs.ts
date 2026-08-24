import type { ReactNode } from "react";

/**
 * A page contributed by whoever embeds the workbench.
 *
 * The workbench gives it a sidebar entry and a tab, and otherwise knows
 * nothing about it — an injected page talks to its own backend. That is what
 * lets this package stay free of any notion of accounts while a product built
 * on top of it adds login, teams, or anything else.
 */
export interface ExtraTab {
  id: string;
  label: string;
  render(): ReactNode;
}
