import path from "node:path";

import {
  defineJourney,
  genetEnv,
  locateGenet,
  parseJson,
  runGenetAsync,
  startHub,
} from "../../framework/public.ts";

interface DesktopDirective {
  navigate: string;
  complete: boolean;
  retryAfterMillis?: number | null;
}

/** Prints the navigation target without spending a credential into the run record (L09). */
function redacted(raw: string): string {
  const url = new URL(raw);
  if (url.pathname.startsWith("/link/")) return `${url.origin}/link/<redacted>`;
  return raw;
}

defineJourney(
  {
    id: "journey.connectivity.desktop-startup-signs-in",
    title: "Desktop startup hands the window a one-use claim link, never a bare workbench URL",
    oracle:
      "A paired daemon's desktop route mints a one-use owner claim link on the Hub; redeeming it signs the window into the account that owns this machine",
    catches: [
      "paired startup navigates to a bare workbench URL and a window whose session cookie is gone stalls signed-out (fb_2ysWxe7-S4Fx)",
      "claim link loses the machine's own workbench address as next",
      "one-use claim link redeems twice",
      "pairing approval never turns the daemon paired",
    ],
    tags: ["core", "connectivity", "desktop", "hub"],
    llm: { default: "none" },
    expectedDurationMs: 30_000,
    timeoutMs: 120_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "genet-cli", "cloud-server"],
    productInterfaces: ["genet-cli", "hub-http"],
  },
  async (t) => {
    const hub = await startHub({ databasePath: path.join(t.env.root, "hub", "control.sqlite") });
    const genet = locateGenet(t.openRoot);
    const env = genetEnv(t.openRoot, { ...t.env.env, GENEHUB_LOCAL_HUB_URL: hub.origin });
    const cli = async (args: string[]) => {
      const result = await runGenetAsync(genet, args, env);
      if (result.code !== 0) {
        throw new Error(`genet ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
      return parseJson(result.stdout);
    };
    const route = async () => (await cli(["desktop", "route"])).data as DesktopDirective;

    try {
      await cli(["daemon", "start"]);

      // First launch on a fresh machine: unpaired, so the route sends the
      // window to the Hub's pairing page and asks the shell to keep polling.
      const first = await route();
      t.assertions.assert(first.complete === false, `unpaired route complete=${first.complete}`);
      const pairing = new URL(first.navigate);
      t.assertions.assert(
        pairing.origin === hub.origin && pairing.pathname === "/activate",
        `pairing page is ${pairing.origin}${pairing.pathname}`,
      );
      const userCode = pairing.searchParams.get("code");
      t.assertions.assert(Boolean(userCode), "pairing page carries no user code");

      // The human half of pairing: the owner approves the code in a browser
      // that signed in through the product's own trial path.
      const owner = hub.browser();
      await hub.signInOwner(owner);
      await hub.approvePairing(owner, userCode!);

      // The daemon polls, enrolls, and turns paired; the route then completes.
      const deadline = Date.now() + 45_000;
      let paired: DesktopDirective | null = null;
      while (Date.now() < deadline) {
        const directive = await route();
        if (directive.complete) {
          paired = directive;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, directive.retryAfterMillis ?? 1_000));
      }
      t.assertions.assert(paired !== null, "the daemon never turned paired after approval");

      // The window that follows the startup navigation is a fresh WebView:
      // no session cookie, exactly like the reported PC after its cookie
      // expired. That precondition holds on every build.
      const webview = hub.browser();
      const anonymous = await webview.fetch("/app/me");
      t.assertions.assert(
        anonymous.status === 401,
        `a fresh window's GET /app/me returned ${anonymous.status}`,
      );

      // The whole point of the route: with no session in the window, only a
      // claim link can sign it back in. A bare workbench URL cannot.
      const navigate = new URL(paired!.navigate);
      t.assertions.assert(
        navigate.origin === hub.origin && navigate.pathname.startsWith("/link/"),
        `startup navigation is ${redacted(paired!.navigate)} — a bare workbench URL strands a window whose session cookie is gone (fb_2ysWxe7-S4Fx)`,
      );

      // The link points back at this machine's own workbench address.
      const next = navigate.searchParams.get("next");
      const nextUrl = next ? new URL(next) : null;
      const machineId = nextUrl?.searchParams.get("desktopMachine") ?? null;
      t.assertions.assert(
        nextUrl !== null && nextUrl.pathname === "/app" && Boolean(machineId),
        `claim link next is ${next}`,
      );

      // GET previews, POST redeems: a link scanner must not spend the login.
      const linkPath = navigate.pathname + navigate.search;
      const preview = await webview.fetch(linkPath);
      t.assertions.assert(preview.status === 200, `claim link preview returned ${preview.status}`);
      t.assertions.assert(webview.cookie() === null, "the preview alone spent the one-use link");
      const redeemed = await webview.fetch(linkPath, { method: "POST" });
      t.assertions.assert(redeemed.status === 303, `claim link redeem returned ${redeemed.status}`);
      t.note(`claim link redeemed; the window lands on ${redeemed.headers.get("location")}`);

      // Signed in, into the account that owns this very machine.
      const signedIn = await webview.json<{ machines?: Array<{ id?: string }> }>("/app/me");
      t.assertions.assert(
        (signedIn.machines ?? []).some((machine) => machine.id === machineId),
        "the signed-in window does not see the machine it is running on",
      );

      // One use means one use.
      const replay = await webview.fetch(linkPath, { method: "POST" });
      t.assertions.assert(replay.status === 410, `one-use link replayed with ${replay.status}`);
    } finally {
      await runGenetAsync(genet, ["daemon", "stop"], env);
      await hub.stop();
    }
  },
);
