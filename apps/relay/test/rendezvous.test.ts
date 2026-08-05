import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RendezvousAuthority, resolveJoinToken } from "../src/forward/rendezvous.js";
import { CLIENT_PATH, DAEMON_PATH } from "../src/contract/index.js";
import { closed, connect, nextMessage, opened, startTestRelay } from "./harness.js";

/**
 * The self-hosted mode. What matters here is what the relay does *not* do:
 * it never asks anyone whether a client should be let in, because in this mode
 * there is nobody to ask. That decision belongs to the machine.
 */
describe("the rendezvous mode", () => {
  it("matches a client to the machine holding the same slot", async () => {
    const relay = await startTestRelay(new RendezvousAuthority(null));
    const machine = opened(await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=slot-1`));
    const client = opened(await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=slot-1`));

    // The machine is told a channel opened, which is all the pairing there is.
    const opening = await nextMessage(machine);
    assert.equal(opening[0], 1);

    client.close();
    machine.close();
    await relay.stop();
  });

  it("turns away a client naming a slot nobody is holding", async () => {
    const relay = await startTestRelay(new RendezvousAuthority(null));
    const result = await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=nobody-is-here`);
    assert.equal("error" in result && result.error, "409");
    await relay.stop();
  });

  /**
   * The token answers "may you use this relay", not "who are you". Getting it
   * wrong must not look like a network fault.
   */
  it("requires the join token from machines when one is configured", async () => {
    const relay = await startTestRelay(new RendezvousAuthority("let-me-in"));

    const refused = await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=wrong.slot-1`);
    assert.equal("error" in refused && refused.error, "403");

    const machine = opened(await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=let-me-in.slot-1`));
    machine.close();
    await relay.stop();
  });

  /**
   * Clients are deliberately exempt: they can only reach a slot some machine is
   * already paying for, so demanding the token of them would mean handing it to
   * every phone that ever connects.
   */
  it("does not ask clients for the join token", async () => {
    const relay = await startTestRelay(new RendezvousAuthority("let-me-in"));
    const machine = opened(await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=let-me-in.slot-1`));
    const client = opened(await connect(`${relay.wsOrigin}${CLIENT_PATH}?ticket=slot-1`));

    client.close();
    machine.close();
    await relay.stop();
  });

  /**
   * Squatting is possible and known: an id that leaked lets someone take the
   * slot while the machine is away. It costs them a denial of service and buys
   * them nothing else, because the client will ask for a proof they cannot
   * produce (`docs/security-model.md` §4.2). This test pins the blast radius.
   */
  it("lets a later machine take over a slot, which is a nuisance and not an impersonation", async () => {
    const relay = await startTestRelay(new RendezvousAuthority(null));
    const first = opened(await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=slot-1`));
    const second = opened(await connect(`${relay.wsOrigin}${DAEMON_PATH}?ticket=slot-1`));

    assert.equal(await closed(first), 4000);
    second.close();
    await relay.stop();
  });

  it("carries no ticket at all as a refusal rather than an empty slot", async () => {
    const authority = new RendezvousAuthority(null);
    assert.equal(await authority.authorizeDaemon(""), null);
    assert.equal(await authority.authorizeClient(""), null);
  });

  /**
   * On loopback there is nothing to protect. Reachable from elsewhere with no
   * token, it would be an open relay — and the previous behaviour, generating
   * one and printing it, left a live secret in the log and taught operators to
   * find their token by reading logs.
   */
  it("will not listen where others can reach it without a token", () => {
    assert.equal(resolveJoinToken(null, "127.0.0.1"), null);
    assert.equal(resolveJoinToken(null, "127.42.0.9"), null);
    assert.equal(resolveJoinToken(null, "::1"), null);
    const strong = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.equal(resolveJoinToken(strong, "0.0.0.0"), strong);
    assert.throws(() => resolveJoinToken(null, "0.0.0.0"), /RELAY_JOIN_TOKEN/);
    assert.throws(() => resolveJoinToken(null, "localhost"), /RELAY_JOIN_TOKEN/);
    assert.throws(() => resolveJoinToken(null, "192.168.1.2"), /RELAY_JOIN_TOKEN/);
    for (const weak of ["a", "configured", "a".repeat(31), "x".repeat(32) + "."]) {
      assert.throws(() => resolveJoinToken(weak, "0.0.0.0"), /32-256/);
    }
    // Loopback does not become remotely reachable merely because a developer
    // retained an old short token in local configuration.
    assert.equal(resolveJoinToken("dev", "127.0.0.1"), "dev");
  });

  /** A wrong token must not be distinguishable by how long the refusal took. */
  it("compares the join token without leaking how much of it matched", async () => {
    const authority = new RendezvousAuthority("let-me-in");
    // Lengths differ, which `timingSafeEqual` refuses to compare at all: the
    // digest in between is what keeps this a refusal instead of a crash.
    assert.equal(await authority.authorizeDaemon("l.slot-1"), null);
    assert.equal(await authority.authorizeDaemon("let-me-in-and-more.slot-1"), null);
    assert.deepEqual(await authority.authorizeDaemon("let-me-in.slot-1"), {
      machineId: "slot-1",
      daemonId: "slot-1",
      connectionGeneration: 1,
      presenceLeaseSeconds: 60,
    });
    assert.deepEqual(await authority.authorizeDaemon("let-me-in.slot-1"), {
      machineId: "slot-1",
      daemonId: "slot-1",
      connectionGeneration: 2,
      presenceLeaseSeconds: 60,
    });
  });
});
