import { useWorkbench } from "../session/store";
import type { Host } from "../host";

/**
 * Opens the account page of the Hub this machine is paired with.
 *
 * The page is the Hub's, not this app's. A deployment that has accounts serves
 * one; this build ships no such screen and could not — the workbench is one
 * open-source program, and an app that bundled a particular company's account
 * pages would stop being the thing anyone can build from source.
 *
 * So the app carries an identity, not a UI. It asks its daemon for a one-time
 * claim link and opens `…/link/{token}?next=/account`: the browser that lands
 * there is signed in as this machine's owner before the account page draws.
 * Opening `/account` directly would arrive as a stranger, and whatever happened
 * next — signing in, binding — would attach to a different identity than the
 * one holding this machine.
 *
 * The system browser rather than a window of our own, deliberately: this is
 * somebody's account, on the open web, and it should be somewhere they can see
 * the address and keep the session afterwards.
 */
export async function openAccount(host: Host): Promise<void> {
  const { hub, claimLink } = useWorkbench.getState();
  if (hub?.state !== "paired") {
    useWorkbench.setState({ notice: "这台机器还没有连到 Hub，还没有账户可以打开。" });
    return;
  }

  try {
    const claim = await claimLink();
    if (!claim) throw new Error("Hub 没有给出链接");
    host.openExternal(`${claim.claimUrl}?next=${encodeURIComponent(ACCOUNT_PATH)}`);
  } catch (error) {
    useWorkbench.setState({
      notice: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Where a Hub puts its account page. A convention rather than a protocol field:
 * a self-hosted Hub that serves nothing there gets a 404 in a browser tab, and
 * inventing a discovery mechanism to avoid that would cost more than the 404.
 */
const ACCOUNT_PATH = "/account";
