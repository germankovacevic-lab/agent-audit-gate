import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInbound, captureOutbound, deriveThreads, lastInboundText } from "../src/capture.ts";

// Obviously-fake placeholder numbers (never real).
const A = "15555550001";
const B = "15555550002";
const C = "15555550003";

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "sb-")), "switchboard.jsonl");
}

async function rows(store: string): Promise<any[]> {
  const raw = await readFile(store, "utf8");
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

test("captureInbound writes in/pending", async () => {
  const store = tmpStore();
  await captureInbound({ phone: A, jid: `${A}@s.whatsapp.net`, text: "menu" }, store);
  const r = await rows(store);
  assert.equal(r.length, 1);
  assert.equal(r[0].direction, "in");
  assert.equal(r[0].state, "pending");
  assert.equal(r[0].phone, A);
});

test("captureOutbound records suppressed and answered in the ledger", async () => {
  const store = tmpStore();
  await captureOutbound({ phone: B, text: "auto draft" }, "suppressed", store);
  await captureOutbound({ phone: A, text: "deliberate reply" }, "answered", store);
  const r = await rows(store);
  assert.equal(r.length, 2);
  assert.equal(r[0].direction, "out");
  assert.equal(r[0].state, "suppressed");
  assert.equal(r[1].direction, "out");
  assert.equal(r[1].state, "answered");
});

test("deriveThreads: last event per phone wins (lifecycle)", async () => {
  const store = tmpStore();
  // thread A: inbound -> answered deliberate (closed)
  await captureInbound({ phone: A, text: "menu" }, store);
  await captureOutbound({ phone: A, text: "reply + info" }, "answered", store);
  // thread B: inbound -> suppressed (closed) -> new inbound (reopens)
  await captureInbound({ phone: B, text: "Test" }, store);
  await captureOutbound({ phone: B, text: "draft" }, "suppressed", store);
  await captureInbound({ phone: B, text: "Another" }, store);

  const threads = await deriveThreads(store);
  assert.equal(threads.get(A)?.state, "answered");
  assert.equal(threads.get(B)?.state, "pending"); // reopened by the new inbound
});

test("deriveThreads over a non-existent store returns an empty map", async () => {
  const threads = await deriveThreads(join(tmpdir(), "no-such-sb", "x.jsonl"));
  assert.equal(threads.size, 0);
});

// --- AUDITOR mode: the draft is held as 'held' instead of being discarded ---

test("captureOutbound records the draft as 'held' (out/held)", async () => {
  const store = tmpStore();
  await captureOutbound({ phone: B, text: "channel draft" }, "held", store);
  const r = await rows(store);
  assert.equal(r.length, 1);
  assert.equal(r[0].direction, "out");
  assert.equal(r[0].state, "held");
  assert.equal(r[0].text, "channel draft");
});

test("auditor lifecycle: inbound(pending) -> draft(held) -> release(answered)", async () => {
  const store = tmpStore();
  await captureInbound({ phone: C, text: "hi, info?" }, store);
  await captureOutbound({ phone: C, text: "draft with internal context" }, "held", store);
  // live state after holding: awaiting audit
  let threads = await deriveThreads(store);
  assert.equal(threads.get(C)?.state, "held");
  // deliberate release after auditing
  await captureOutbound({ phone: C, text: "clean reply" }, "answered", store);
  threads = await deriveThreads(store);
  assert.equal(threads.get(C)?.state, "answered");
});

test("captureOutbound records 'dropped' when I audit and do NOT reply", async () => {
  const store = tmpStore();
  await captureOutbound({ phone: C, text: "discarded draft" }, "dropped", store);
  const threads = await deriveThreads(store);
  assert.equal(threads.get(C)?.state, "dropped");
});

test("lastInboundText returns the phone's latest inbound (message to audit)", async () => {
  const store = tmpStore();
  await captureInbound({ phone: C, text: "first" }, store);
  await captureInbound({ phone: C, text: "second (the current one)" }, store);
  await captureInbound({ phone: A, text: "from another" }, store);
  assert.equal(await lastInboundText(C, store), "second (the current one)");
  assert.equal(await lastInboundText(A, store), "from another");
});

test("lastInboundText returns '' if there is no inbound for that phone", async () => {
  const store = tmpStore();
  await captureInbound({ phone: C, text: "x" }, store);
  assert.equal(await lastInboundText("0000", store), "");
  assert.equal(await lastInboundText("0000", join(tmpdir(), "no-such", "y.jsonl")), "");
});
