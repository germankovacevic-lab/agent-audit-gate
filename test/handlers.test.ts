import { test } from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test"; // no handler may fall through to a live gateway

// Obviously-fake placeholder allowlist (the operator's + agent's own lines).
const OPERATOR = "15551230001";
process.env.SWITCHBOARD_OWN_NUMBERS = `${OPERATOR},15551230002`;

import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInbound, handleSending, resolveChannels } from "../src/handlers.ts";

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "sb-h-")), "switchboard.jsonl");
}
async function rows(store: string): Promise<any[]> {
  const raw = await readFile(store, "utf8").catch(() => "");
  return raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
}
function fakeNotify() {
  const calls: any[] = [];
  return { calls, fn: async (_api: any, opts: any) => { calls.push(opts); } };
}

const THIRD = "15555550000";
const THIRD_JID = "15555550000@s.whatsapp.net";

test("handleInbound captures pending and does NOT notify (wake arrives with the draft)", async () => {
  const store = tmpStore();
  const notify = fakeNotify();
  await handleInbound({}, { channel: "whatsapp", senderId: THIRD_JID, content: "hi, info?" }, {}, { store, notify: notify.fn });
  const r = await rows(store);
  assert.equal(r.length, 1);
  assert.equal(r[0].state, "pending");
  assert.equal(r[0].direction, "in");
  assert.equal(notify.calls.length, 0, "inbound must not wake the reviewer");
});

test("handleInbound ignores the operator (not a third party)", async () => {
  const store = tmpStore();
  await handleInbound({}, { channel: "whatsapp", senderId: OPERATOR, content: "hey" }, {}, { store, notify: fakeNotify().fn });
  assert.equal((await rows(store)).length, 0);
});

test("handleInbound ignores groups and non-whatsapp channels", async () => {
  const store = tmpStore();
  await handleInbound({}, { channel: "whatsapp", senderId: THIRD_JID, content: "x", sessionKey: "agent:main:group:123" }, {}, { store, notify: fakeNotify().fn });
  await handleInbound({}, { channel: "telegram", senderId: THIRD_JID, content: "x" }, {}, { store, notify: fakeNotify().fn });
  assert.equal((await rows(store)).length, 0);
});

test("handleSending: auto-reply to a third party → HOLD held + notify with inbound+draft + cancel", async () => {
  const store = tmpStore();
  const notify = fakeNotify();
  // first there is a 'pending' inbound in the ledger (what the draft replies to)
  await handleInbound({}, { channel: "whatsapp", senderId: THIRD_JID, content: "I want a quote" }, {}, { store, notify: notify.fn });
  // the channel generates the draft (auto-reply: ctx.senderId present)
  const ret = await handleSending(
    {},
    { channel: "whatsapp", content: "Hi! Here is the operator's internal pricing..." },
    { senderId: THIRD_JID },
    { store, notify: notify.fn },
  );
  assert.deepEqual(ret, { cancel: true, cancelReason: "switchboard: draft held for audit (operator releases deliberately)" });
  const r = await rows(store);
  assert.equal(r[1].state, "held");
  assert.equal(r[1].direction, "out");
  assert.equal(notify.calls.length, 1, "must wake the reviewer to audit");
  assert.equal(notify.calls[0].phone, THIRD);
  assert.equal(notify.calls[0].inbound, "I want a quote", "carries the original inbound");
  assert.ok(notify.calls[0].draft.includes("internal pricing"), "carries the draft to audit");
});

test("handleSending: deliberate send (no ctx.senderId) to a third party → answered and PASSES", async () => {
  const store = tmpStore();
  const notify = fakeNotify();
  const ret = await handleSending(
    {},
    { channel: "whatsapp", to: THIRD_JID, content: "clean audited reply" },
    {}, // no senderId = deliberate operator send
    { store, notify: notify.fn },
  );
  assert.equal(ret, undefined, "does not cancel: the deliberate send passes");
  const r = await rows(store);
  assert.equal(r[0].state, "answered");
  assert.equal(notify.calls.length, 0);
});

test("handleSending: auto-reply to the operator is NOT held (passes normally)", async () => {
  const store = tmpStore();
  const notify = fakeNotify();
  const ret = await handleSending(
    {},
    { channel: "whatsapp", content: "hey there" },
    { senderId: OPERATOR },
    { store, notify: notify.fn },
  );
  assert.equal(ret, undefined);
  assert.equal((await rows(store)).length, 0);
  assert.equal(notify.calls.length, 0);
});

test("resolveChannels: deps.channels over env over default", () => {
  assert.deepEqual(resolveChannels({ channels: ["telegram"] }, {} as NodeJS.ProcessEnv), ["telegram"]);
  assert.deepEqual(
    resolveChannels({}, { SWITCHBOARD_CHANNELS: "signal, telegram" } as NodeJS.ProcessEnv),
    ["signal", "telegram"],
  );
  assert.deepEqual(resolveChannels({}, {} as NodeJS.ProcessEnv), ["whatsapp"]);
  // blank/invalid env → fall back to default (fail-safe)
  assert.deepEqual(resolveChannels({}, { SWITCHBOARD_CHANNELS: " , " } as NodeJS.ProcessEnv), ["whatsapp"]);
});

test("handlers intercept a non-default channel when configured via deps.channels", async () => {
  const store = tmpStore();
  const notify = fakeNotify();
  await handleInbound(
    {},
    { channel: "telegram", senderId: THIRD_JID, content: "hi, info?" },
    {},
    { store, notify: notify.fn, channels: ["telegram"] },
  );
  const r = await rows(store);
  assert.equal(r.length, 1, "telegram inbound is captured when telegram is in the channel set");
  assert.equal(r[0].state, "pending");
});
