import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Guard: no test may fall through to a real gateway config or POST to a live gateway.
process.env.NODE_ENV = "test";

import {
  buildAuditText,
  resolveWakeEndpoint,
  notifyAudit,
  resolveAuditTextConfig,
  DEFAULT_AUDIT_POLICY,
} from "../src/notify.ts";

const PHONE = "15555550000"; // obviously-fake placeholder

test("buildAuditText includes phone, inbound, draft and the release action", () => {
  const t = buildAuditText({ phone: PHONE, inbound: "hi, give me info", draft: "I'm a bot and..." });
  assert.ok(t.includes(PHONE), "includes the phone");
  assert.ok(t.includes("hi, give me info"), "includes the third party's message");
  assert.ok(t.includes("I'm a bot and..."), "includes the draft to audit");
  assert.ok(/message send/i.test(t), "mentions how to release (message send)");
});

test("buildAuditText tolerates an empty inbound (draft with no prior inbound in the ledger)", () => {
  const t = buildAuditText({ phone: "15550000", inbound: "", draft: "something" });
  assert.ok(t.includes("15550000"));
  assert.ok(t.includes("something"));
});

test("resolveWakeEndpoint: null if hooks disabled", () => {
  const ep = resolveWakeEndpoint({ config: { hooks: { enabled: false, token: "t" }, gateway: { port: 1 } } });
  assert.equal(ep, null);
});

test("resolveWakeEndpoint: null if the token is missing", () => {
  const ep = resolveWakeEndpoint({ config: { hooks: { enabled: true }, gateway: { port: 1 } } });
  assert.equal(ep, null);
});

test("resolveWakeEndpoint: builds the loopback URL with port + path", () => {
  const ep = resolveWakeEndpoint({
    config: { hooks: { enabled: true, token: "secret", path: "/hooks" }, gateway: { port: 18789 } },
  });
  assert.ok(ep);
  assert.equal(ep!.url, "http://127.0.0.1:18789/hooks/wake");
  assert.equal(ep!.token, "secret");
});

test("notifyAudit POSTs the real wake to /hooks/wake (loopback) with Bearer + text", async () => {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const api = { config: { hooks: { enabled: true, token: "tok-123", path: "/hooks" }, gateway: { port } } };
    await notifyAudit(api, { phone: PHONE, inbound: "info?", draft: "leaky draft" });
    assert.equal(received.length, 1, "the wake reached the endpoint");
    assert.equal(received[0].url, "/hooks/wake");
    assert.equal(received[0].auth, "Bearer tok-123");
    assert.equal(received[0].body.mode, "now");
    assert.ok(received[0].body.text.includes(PHONE));
    assert.ok(received[0].body.text.includes("leaky draft"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("notifyAudit falls back to enqueueNextTurnInjection if there is no hooks endpoint", async () => {
  const injections: any[] = [];
  const api = {
    config: { hooks: { enabled: false } },
    enqueueNextTurnInjection: async (i: any) => { injections.push(i); },
  };
  await notifyAudit(api, { phone: "15550000", inbound: "a", draft: "b" });
  assert.equal(injections.length, 1);
  assert.equal(injections[0].sessionKey, "agent:main:main");
  assert.ok(injections[0].text.includes("15550000"));
});

test("notifyAudit does not blow up if there is no endpoint and no fallback", async () => {
  await notifyAudit({ config: { hooks: { enabled: false } } }, { phone: "15550000", inbound: "a", draft: "b" });
});

test("buildAuditText uses a custom policy when provided, and the default otherwise", () => {
  const custom = buildAuditText({ phone: PHONE, inbound: "x", draft: "y" }, { policy: "MY CUSTOM POLICY" });
  assert.ok(custom.includes("MY CUSTOM POLICY"), "uses the configured policy");
  assert.ok(!custom.includes(DEFAULT_AUDIT_POLICY), "drops the default when overridden");
  const def = buildAuditText({ phone: PHONE, inbound: "x", draft: "y" });
  assert.ok(def.includes(DEFAULT_AUDIT_POLICY), "falls back to the default policy");
});

test("buildAuditText release command reflects the configured channel", () => {
  const t = buildAuditText({ phone: PHONE, inbound: "x", draft: "y" }, { releaseChannel: "telegram" });
  assert.ok(t.includes("--channel telegram"), "uses the configured release channel");
  assert.ok(!t.includes("--channel whatsapp"), "no longer hardcodes whatsapp");
});

test("resolveAuditTextConfig reads policy + release channel from env (injected)", () => {
  const cfg = resolveAuditTextConfig({
    SWITCHBOARD_AUDIT_POLICY: "P",
    SWITCHBOARD_RELEASE_CHANNEL: "signal",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.policy, "P");
  assert.equal(cfg.releaseChannel, "signal");
});

test("resolveAuditTextConfig derives the release channel from the first SWITCHBOARD_CHANNELS entry", () => {
  const cfg = resolveAuditTextConfig({ SWITCHBOARD_CHANNELS: "telegram, signal" } as NodeJS.ProcessEnv);
  assert.equal(cfg.releaseChannel, "telegram", "first channel becomes the release channel");
  // explicit SWITCHBOARD_RELEASE_CHANNEL still wins over the derived one
  const explicit = resolveAuditTextConfig({
    SWITCHBOARD_CHANNELS: "telegram",
    SWITCHBOARD_RELEASE_CHANNEL: "signal",
  } as NodeJS.ProcessEnv);
  assert.equal(explicit.releaseChannel, "signal");
});

test("resolveAuditTextConfig ignores blank env values (→ defaults apply downstream)", () => {
  const cfg = resolveAuditTextConfig({
    SWITCHBOARD_AUDIT_POLICY: "  ",
    SWITCHBOARD_RELEASE_CHANNEL: "",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.policy, undefined);
  assert.equal(cfg.releaseChannel, undefined);
});
