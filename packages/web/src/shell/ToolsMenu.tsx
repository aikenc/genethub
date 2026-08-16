import type { ReactNode } from "react";

import { useWorkbench } from "../session/store";
import type { ExtraTab } from "./tabs";

/**
 * The right-hand tool list, split the way the workbench is split:
 * workspace surfaces, then machine-wide / product-wide actions.
 */
export function ToolsMenu({
  extraTabs,
  onNavigate,
  children,
  density = "desktop",
}: {
  extraTabs: ExtraTab[];
  onNavigate(): void;
  children?: ReactNode;
  density?: "desktop" | "phone";
}) {
  const { openTab, setRightPanel } = useWorkbench();
  const phone = density === "phone";
  const go = (kind: Parameters<typeof openTab>[0], title?: string) => {
    openTab(kind, title);
    onNavigate();
  };
  const openFiles = () => {
    if (phone) {
      go("files");
      return;
    }
    setRightPanel("files");
    onNavigate();
  };
  const openChanges = () => {
    setRightPanel("changes");
    onNavigate();
  };

  return (
    <nav className={`flex flex-1 flex-col overflow-y-auto ${phone ? "gap-3 p-3" : "gap-3 p-3"}`}>
      <Section title="工作区" phone={phone}>
        <Entry phone={phone} label="变更" onClick={openChanges} />
        <Entry phone={phone} label="文件" onClick={openFiles} />
        <Entry phone={phone} label="终端" onClick={() => go("terminal")} />
        <Entry phone={phone} label="后台进程" onClick={() => go("processes")} />
        {extraTabs.map((tab) => (
          <Entry
            key={tab.id}
            phone={phone}
            label={tab.label}
            onClick={() => go(`extra:${tab.id}`, tab.label)}
          />
        ))}
      </Section>
      <Section title="全局" phone={phone}>
        <Entry phone={phone} label="设备" onClick={() => go("devices")} />
        <Entry phone={phone} label="设置" onClick={() => go("settings")} />
        {children ? (
          <div
            className={
              phone
                ? "[&_button]:min-h-11 [&_button]:w-full [&_button]:justify-start [&_button]:rounded-xl [&_button]:px-4 [&_button]:text-left [&_button]:text-base [&_button]:shadow-none"
                : "[&_button]:min-h-10 [&_button]:w-full [&_button]:justify-start [&_button]:rounded-lg [&_button]:px-3 [&_button]:text-left [&_button]:text-sm [&_button]:shadow-none"
            }
            onClick={onNavigate}
          >
            {children}
          </div>
        ) : null}
      </Section>
    </nav>
  );
}

function Section({
  title,
  phone,
  children,
}: {
  title: string;
  phone: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <p
        className={`px-3 pb-1 font-medium uppercase tracking-wide text-faint ${
          phone ? "text-[11px]" : "text-[10px]"
        }`}
      >
        {title}
      </p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Entry({
  label,
  onClick,
  phone,
}: {
  label: string;
  onClick(): void;
  phone: boolean;
}) {
  return (
    <button
      type="button"
      className={
        phone
          ? "flex min-h-11 w-full items-center rounded-xl px-4 text-left text-base text-muted active:bg-sidebar-hover active:text-fg"
          : "flex min-h-10 w-full items-center rounded-lg px-3 text-left text-sm text-muted hover:bg-sidebar-hover hover:text-fg"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}
