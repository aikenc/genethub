import { useEffect, useRef, useState } from "react";

import type { Host, WindowControls } from "../host";
import { useWorkbench } from "../session/store";
import { THEME_OPTIONS, useTheme } from "../theme/store";

/**
 * The strip across the top of the desktop window, drawn by us.
 *
 * It exists because the native one could not be made to match. A system title
 * bar takes its colour from the OS, so every Windows machine on the light theme
 * put a white band above a dark workbench — the app looked like two programs
 * stacked on top of each other. Turning the decorations off
 * (`tauri.conf.json`) and drawing this instead is what makes the window one
 * thing, in either palette.
 *
 * Only where the shell owns a window. A browser tab has a frame that belongs to
 * the browser, and adding a second one inside the page would be a fake.
 */
export function TitleBar({
  host,
  sidebarHidden,
  onToggleSidebar,
}: {
  host: Host;
  sidebarHidden: boolean;
  onToggleSidebar(): void;
}) {
  const controls = host.window;
  if (!controls) return null;
  return (
    <header
      data-tauri-drag-region
      // No padding on the right: the close button has to reach the corner of
      // the screen, which is the one place a pointer can be thrown at without
      // aiming.
      className="flex h-9 shrink-0 select-none items-center gap-1 border-b border-line bg-sidebar pl-2"
    >
      <span
        data-tauri-drag-region
        className="pointer-events-none px-1.5 text-xs font-medium text-muted"
      >
        GeneHub
      </span>
      <AppMenu host={host} sidebarHidden={sidebarHidden} onToggleSidebar={onToggleSidebar} />
      {/* The rest of the bar is the handle. Without something growing here the
          window can only be dragged by the few pixels between the buttons. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <WindowButtons controls={controls} />
    </header>
  );
}

const MENUS = ["文件", "视图", "帮助"] as const;
type MenuName = (typeof MENUS)[number];

/**
 * A menu bar, in the window rather than on the system bar.
 *
 * Same actions as the tray, in the same words. The tray is what someone reaches
 * for when the window is closed; this is what they reach for when it is open,
 * and two vocabularies for one set of actions would be two things to learn.
 */
function AppMenu({
  host,
  sidebarHidden,
  onToggleSidebar,
}: {
  host: Host;
  sidebarHidden: boolean;
  onToggleSidebar(): void;
}) {
  const [open, setOpen] = useState<MenuName | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!bar.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={bar} className="flex items-center" role="menubar">
      {MENUS.map((name) => (
        <div key={name} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === name}
            className={`rounded px-2 py-1 text-xs ${
              open === name ? "bg-raised text-fg" : "text-muted hover:bg-sidebar-hover hover:text-fg"
            }`}
            onClick={() => setOpen((current) => (current === name ? null : name))}
            // Once one is open the bar behaves like a menu bar: sliding across
            // the titles walks the menus, rather than needing a click each time.
            onMouseEnter={() => setOpen((current) => (current ? name : current))}
          >
            {name}
          </button>
          {open === name ? (
            <Dropdown name={name}>
              <Items
                name={name}
                host={host}
                sidebarHidden={sidebarHidden}
                onToggleSidebar={onToggleSidebar}
                close={() => setOpen(null)}
              />
            </Dropdown>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Dropdown({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div
      role="menu"
      aria-label={name}
      className="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-md border border-line-strong bg-surface py-1 shadow-[0_8px_30px_rgb(0_0_0_/0.35)]"
    >
      {children}
    </div>
  );
}

function Items({
  name,
  host,
  sidebarHidden,
  onToggleSidebar,
  close,
}: {
  name: MenuName;
  host: Host;
  sidebarHidden: boolean;
  onToggleSidebar(): void;
  close(): void;
}) {
  const {
    openTab,
    setRightPanel,
    newSession,
    openWorkspace,
    activeWorkspaceId,
    checkUpdate,
    claimLink,
  } = useWorkbench();
  const { preference, setPreference } = useTheme();

  const run = (action: () => void) => () => {
    close();
    action();
  };

  if (name === "文件") {
    return (
      <>
        <Item
          disabled={!activeWorkspaceId}
          onSelect={run(() => {
            if (activeWorkspaceId) newSession(activeWorkspaceId, null);
          })}
        >
          新建会话
        </Item>
        <Item
          // Only where a folder can be browsed. In a browser the daemon is on
          // another machine and there is nothing here to pick from, so that
          // path is typed into the sidebar instead of guessed at from a menu.
          disabled={!host.pickDirectory}
          onSelect={run(() => {
            void host.pickDirectory?.().then((picked) => {
              if (picked) void openWorkspace(picked);
            });
          })}
        >
          打开项目…
        </Item>
        <Separator />
        <Item onSelect={run(() => openTab("settings"))}>设置</Item>
        <Item onSelect={run(() => host.window?.close())}>关闭窗口</Item>
      </>
    );
  }

  if (name === "视图") {
    return (
      <>
        <Item onSelect={run(() => openTab("files"))}>文件</Item>
        <Item onSelect={run(() => openTab("terminal"))}>终端</Item>
        <Item onSelect={run(() => setRightPanel("changes"))}>变更</Item>
        <Item onSelect={run(() => openTab("devices"))}>设备</Item>
        <Separator />
        <Item onSelect={run(onToggleSidebar)}>{sidebarHidden ? "显示左栏" : "隐藏左栏"}</Item>
        <Separator />
        <Label>外观</Label>
        {THEME_OPTIONS.map((option) => (
          <Item
            key={option.value}
            checked={preference === option.value}
            onSelect={run(() => setPreference(option.value))}
          >
            {option.label}
          </Item>
        ))}
      </>
    );
  }

  return (
    <>
      {/* Asked for by hand and never on a timer, same as from the tray: the
          answer lands in the version section of settings either way. */}
      <Item
        onSelect={run(() => {
          void checkUpdate();
          openTab("settings");
        })}
      >
        检查更新
      </Item>
      <Item disabled={!host.openLogs} onSelect={run(() => host.openLogs?.())}>
        打开日志目录
      </Item>
      <Separator />
      <Item onSelect={run(() => openTab("settings"))}>连接到 Hub</Item>
      <Item
        onSelect={run(() => {
          // Minted before the page is shown, as in the tray: arriving on
          // settings with nothing new on it reads as a menu item that did
          // nothing, and "did nothing" and "already up to date" look alike.
          void claimLink().catch((error: unknown) =>
            useWorkbench.setState({
              notice: error instanceof Error ? error.message : String(error),
            }),
          );
          openTab("settings");
        })}
      >
        重新生成认领链接
      </Item>
    </>
  );
}

function Item({
  children,
  onSelect,
  disabled,
  checked,
}: {
  children: React.ReactNode;
  onSelect(): void;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
      onClick={onSelect}
    >
      {checked === undefined ? null : (
        <span className="w-3 shrink-0 text-accent-bright" aria-hidden>
          {checked ? "✓" : ""}
        </span>
      )}
      <span className="truncate">{children}</span>
    </button>
  );
}

function Separator() {
  return <div role="separator" className="my-1 border-t border-line" />;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-faint">{children}</p>
  );
}

/**
 * Minimise, maximise and close.
 *
 * Ours on every platform, including macOS. Turning decorations off removes the
 * traffic lights along with everything else, so reserving a gap for them there
 * would leave that build with no way to close the window at all. A signed macOS
 * release would be the moment to switch that platform to an overlay title bar
 * and give the space back to the system.
 */
function WindowButtons({ controls }: { controls: WindowControls }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void controls.isMaximized().then(setMaximized).catch(() => undefined);
  }, [controls]);

  return (
    <div className="flex items-center">
      <Control label="最小化" onClick={() => controls.minimize()}>
        <rect x="3" y="7.5" width="10" height="1" />
      </Control>
      <Control
        label={maximized ? "还原" : "最大化"}
        onClick={() => void controls.toggleMaximize().then(setMaximized)}
      >
        {maximized ? (
          <>
            <rect x="3" y="5" width="7" height="7" fill="none" strokeWidth="1" stroke="currentColor" />
            <path d="M5.5 5V3.5H13V11h-1.5" fill="none" strokeWidth="1" stroke="currentColor" />
          </>
        ) : (
          <rect x="3.5" y="3.5" width="9" height="9" fill="none" strokeWidth="1" stroke="currentColor" />
        )}
      </Control>
      <Control label="关闭" danger onClick={() => controls.close()}>
        <path d="M4 4l8 8M12 4l-8 8" fill="none" strokeWidth="1" stroke="currentColor" />
      </Control>
    </div>
  );
}

function Control({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick(): void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-9 w-11 items-center justify-center text-muted ${
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-sidebar-hover hover:text-fg"
      }`}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
