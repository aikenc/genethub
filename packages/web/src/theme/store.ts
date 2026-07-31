/**
 * Which of the two palettes is in force, and who decided.
 *
 * Three states rather than a boolean, because "follow the system" is a real
 * answer and not the same as either colour: a machine that flips to dark in the
 * evening should take the workbench with it, and only the person who never
 * chose gets that. Kept out of `settings.*` on purpose — the daemon's settings
 * are the machine's, shared by every client connected to it, and which colours
 * a phone in a dark room wants have nothing to do with what the laptop wants.
 */

import { create } from "zustand";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

/** Also read by the inline script in `index.html`; change both or neither. */
export const THEME_KEY = "genehub.theme";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Blocked by browser settings. The workbench still runs and still switches;
    // it just forgets the choice on reload, which beats refusing to start.
    return null;
  }
}

export function readPreference(storage: Storage | null = store()): ThemePreference {
  const raw = storage?.getItem(THEME_KEY);
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

/** What the OS is asking for. Dark when nothing can be asked: that is our default. */
export function systemTheme(): ResolvedTheme {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * Puts the class on `<html>`, which is the only thing that actually changes
 * colours: every token lives on `:root` and every component reads tokens.
 */
export function applyTheme(resolved: ResolvedTheme, root?: Element | null): void {
  const element = root ?? globalThis.document?.documentElement;
  if (!element) return;
  element.classList.remove("dark", "light");
  element.classList.add(resolved);
}

/**
 * Watches the OS setting, and returns an unsubscribe.
 *
 * Subscribed always, not only while the preference is `system`: the listener is
 * free, and attaching it lazily means the first flip after someone switches
 * back to `system` is the one that gets missed.
 */
export function watchSystemTheme(listener: (theme: ResolvedTheme) => void): () => void {
  let query: MediaQueryList | undefined;
  try {
    query = globalThis.matchMedia?.("(prefers-color-scheme: light)");
  } catch {
    return () => {};
  }
  if (!query?.addEventListener) return () => {};
  const handler = (event: MediaQueryListEvent) => listener(event.matches ? "light" : "dark");
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  /** The OS changed its mind. Only moves the screen while nobody has chosen. */
  systemChanged(theme: ResolvedTheme): void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const preference = readPreference();
  return {
    preference,
    resolved: resolveTheme(preference),

    setPreference(next) {
      const resolved = resolveTheme(next);
      store()?.setItem(THEME_KEY, next);
      applyTheme(resolved);
      set({ preference: next, resolved });
    },

    systemChanged(theme) {
      if (get().preference !== "system") return;
      applyTheme(theme);
      set({ resolved: theme });
    },
  };
});

/** What the appearance control shows, in the order it shows them. */
export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "暗色" },
  { value: "light", label: "亮色" },
];
