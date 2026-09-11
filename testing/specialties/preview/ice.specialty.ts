import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { defineSpecialty, startHub } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.preview.channel-ice-credentials",
    title:
      "Channel ICE exposes STUN and authenticates bounded TURN credentials",
    oracle:
      "public config contains only the configured STUN; anonymous minting fails; an enrolled machine receives standard expiring TURN REST credentials; oversized body fails",
    catches: [
      "public TURN signing secret leak",
      "unauthenticated allocation credentials",
      "channel configuration ignored",
      "unbounded credential request",
    ],
    tags: ["network-risk-v2", "core", "service-preview", "hub"],
    llm: { default: "none" },
    expectedDurationMs: 5000,
    timeoutMs: 30000,
    resources: {
      environments: 1,
      cpu: 1,
      memoryMb: 512,
      io: 1,
      browser: 0,
      pool: "standard",
    },
    surfaces: ["cloud-server"],
    productInterfaces: ["hub-http"],
  },
  async (t) => {
    const signingSecret = randomBytes(32).toString("hex");
    for (const prefix of ["HUB_", "HUB_BETA_", "HUB_DEV_"]) {
      process.env[prefix + "ICE_SERVERS"] = '["stun:127.0.0.1:3480"]';
      process.env[prefix + "TURN_URLS"] =
        '["turn:127.0.0.1:3480?transport=udp"]';
      process.env[prefix + "MEDIA_TURN_ENABLED"] = "1";
      process.env[prefix + "TURN_AUTH_SECRET"] = signingSecret;
    }
    const hub = await startHub({
      databasePath: join(t.env.root, "hub", "control.sqlite"),
    });
    try {
      const response = await fetch(hub.origin + "/api/rtc/config");
      const config = await response.json();
      t.assertions.assert(
        response.status === 200 &&
          config.iceServers[0].urls[0] === "stun:127.0.0.1:3480",
        "Channel STUN config missing",
      );
      t.assertions.assert(
        !JSON.stringify(config).includes(signingSecret) &&
          !JSON.stringify(config).includes("credential"),
        "public config contains credential",
      );
      const malformed=await fetch(hub.origin+'/api/rtc/credentials',{method:'POST',headers:{'content-type':'application/json'},body:'null'});
    t.assertions.assert(malformed.status===400,'malformed credential request was not rejected');await malformed.body?.cancel();
    const owner = hub.browser();
      await hub.signInOwner(owner);
      const start = await owner.json<{ deviceCode: string; userCode: string }>(
        "/api/device-authorizations",
        {
          method: "POST",
          body: JSON.stringify({ displayName: "RTC validation machine" }),
        },
      );
      await hub.approvePairing(owner, start.userCode);
      const polled = await owner.json<{ enrollmentToken: string }>(
        "/api/device-authorizations/poll",
        {
          method: "POST",
          body: JSON.stringify({ deviceCode: start.deviceCode }),
        },
      );
      const machineSecret = randomBytes(32).toString("hex"),
        daemonId = "rtc-validation-" + randomBytes(8).toString("hex");
      const enrolled = await fetch(hub.origin + "/api/machines/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + polled.enrollmentToken,
        },
        body: JSON.stringify({
          daemonId,
          publicKey: randomBytes(32).toString("base64"),
          credentialVerifier: createHash("sha256")
            .update(machineSecret)
            .digest("base64url"),
        }),
      });
      t.assertions.assert(enrolled.status === 200, "machine enrollment failed");
      await enrolled.body?.cancel();
      const payload = JSON.stringify({
        daemonId,
        runId: randomBytes(16).toString("hex"),
      });
      const anonymous = await fetch(hub.origin + "/api/rtc/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      t.assertions.assert(
        anonymous.status === 403,
        "anonymous TURN minting accepted",
      );
      await anonymous.body?.cancel();
      const minted = await fetch(hub.origin + "/api/rtc/credentials", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + machineSecret,
        },
        body: payload,
      });
      const credentials = await minted.json();
      t.assertions.assert(
        minted.status === 200 &&
          minted.headers.get("cache-control") === "no-store",
        "credential mint failed or cached",
      );
      const turn = credentials.iceServers.find(
        (s: { credential?: string }) => s.credential,
      );
      t.assertions.assert(
        turn?.credential ===
          createHmac("sha1", signingSecret)
            .update(turn.username)
            .digest("base64"),
        "not a standard TURN REST password",
      );
      const remaining = Number(turn.username.split(":")[0]) - Date.now() / 1000;
      t.assertions.assert(
        remaining > 0 && remaining <= 600,
        "TURN credential expiry unbounded",
      );
      for (const [identity, secret] of [[daemonId, machineSecret + "-wrong"], [daemonId + "-other", machineSecret]]) {
        const denied = await fetch(hub.origin + "/api/rtc/credentials", {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret },
          body: JSON.stringify({ daemonId: identity, runId: randomBytes(16).toString("hex") }),
        });
        t.assertions.assert(denied.status === 403, "wrong machine identity or secret minted TURN credentials");
        await denied.body?.cancel();
      }
      const oversized = await fetch(hub.origin + "/api/rtc/credentials", {
        method: "POST",
        body: "x".repeat(2048),
      });
      t.assertions.assert(
        oversized.status === 413,
        "oversized credential body accepted",
      );
      await oversized.body?.cancel();
    } finally {
      await hub.stop();
    }
  },
);
