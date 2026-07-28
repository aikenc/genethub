/**
 * The only module allowed to know which shell it is running in.
 *
 * Business components must never branch on the host. When they need something
 * only one shell can do, it goes behind this interface, or it is declared
 * optional and the entry point is hidden when it is missing — the same way an
 * agent's `Capabilities` decide which controls exist (`web-workbench.md` §7).
 */
export function detectHost() {
    return typeof window !== "undefined" && window.__TAURI__ ? desktopHost() : browserHost();
}
/**
 * In a browser the endpoint arrives in the fragment, put there by the Hub page
 * that minted the ticket. The fragment rather than the query string on purpose:
 * it is not sent to the server, so the ticket stays out of access logs.
 */
export function browserHost(location = window.location) {
    return {
        kind: "browser",
        async endpoint() {
            const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
            const url = fragment.get("endpoint");
            if (!url)
                return null;
            return {
                url,
                via: url.includes("/forward/client") ? "relay" : "lan",
                label: new URL(url).host,
            };
        },
        notify({ title, body }) {
            if (typeof Notification === "undefined")
                return;
            if (Notification.permission === "granted") {
                new Notification(title, body === undefined ? undefined : { body });
                return;
            }
            if (Notification.permission !== "denied")
                void Notification.requestPermission();
        },
        openExternal(url) {
            window.open(url, "_blank", "noopener,noreferrer");
        },
    };
}
/**
 * The desktop shell already has the daemon running as a sidecar, so it knows
 * the loopback port and token and hands them over rather than making the user
 * pair with their own machine.
 */
export function desktopHost() {
    const tauri = window.__TAURI__;
    return {
        kind: "desktop",
        async endpoint() {
            const found = await tauri.core.invoke("daemon_endpoint");
            if (!found)
                return null;
            return {
                url: `ws://127.0.0.1:${found.port}/ws?token=${found.token}`,
                via: "loopback",
                label: "这台电脑",
            };
        },
        notify(notification) {
            void tauri.core.invoke("notify", { ...notification });
        },
        openExternal(url) {
            void tauri.core.invoke("open_external", { url });
        },
        async pickDirectory() {
            return tauri.core.invoke("pick_directory");
        },
    };
}
