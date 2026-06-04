import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStaleThreads, buildStaleAlert } from "../src/sweep.ts";

const PHONE = "15555550000"; // obviously-fake placeholder

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "sb-sweep-")), "switchboard.jsonl");
}
async function writeLedger(store: string, rows: object[]): Promise<void> {
  await writeFile(store, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}
function rec(over: Record<string, unknown>) {
  return { ts: "2026-01-01T00:00:00.000Z", direction: "in", phone: PHONE, text: "x", state: "pending", ...over };
}

const NOW = Date.parse("2026-01-01T01:00:00.000Z"); // fixed clock for the tests
const FIFTEEN_MIN = 15 * 60_000;

test("no stale threads when everything is recent", async () => {
  const store = tmpStore();
  await writeLedger(store, [rec({ ts: new Date(NOW - 60_000).toISOString(), state: "held", direction: "out" })]);
  assert.deepEqual(await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN }), []);
});

test("a held draft older than the threshold is reported", async () => {
  const store = tmpStore();
  await writeLedger(store, [
    rec({ ts: new Date(NOW - 20 * 60_000).toISOString(), state: "held", direction: "out", text: "leaky draft" }),
  ]);
  const stale = await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].state, "held");
  assert.equal(stale[0].phone, PHONE);
  assert.equal(stale[0].lastText, "leaky draft");
});

test("a pending inbound older than the threshold is reported", async () => {
  const store = tmpStore();
  await writeLedger(store, [rec({ ts: new Date(NOW - 30 * 60_000).toISOString(), state: "pending" })]);
  const stale = await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].state, "pending");
});

test("a thread closed by answered/dropped is NOT reported (last event wins)", async () => {
  const store = tmpStore();
  await writeLedger(store, [
    rec({ ts: new Date(NOW - 40 * 60_000).toISOString(), state: "held", direction: "out" }),
    rec({ ts: new Date(NOW - 35 * 60_000).toISOString(), state: "answered", direction: "out" }),
  ]);
  assert.deepEqual(await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN }), []);
});

test("suppressed/bot_loop are never reported, however old", async () => {
  const store = tmpStore();
  await writeLedger(store, [
    rec({ phone: "15550000001", ts: new Date(NOW - 60 * 60_000).toISOString(), state: "suppressed", direction: "out" }),
    rec({ phone: "15550000002", ts: new Date(NOW - 60 * 60_000).toISOString(), state: "bot_loop" }),
  ]);
  assert.deepEqual(await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN }), []);
});

test("threshold boundary: exactly at the threshold is NOT stale; 1ms older is", async () => {
  const store = tmpStore();
  await writeLedger(store, [rec({ ts: new Date(NOW - FIFTEEN_MIN).toISOString(), state: "held", direction: "out" })]);
  assert.equal((await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN })).length, 0);
  await writeLedger(store, [rec({ ts: new Date(NOW - FIFTEEN_MIN - 1).toISOString(), state: "held", direction: "out" })]);
  assert.equal((await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN })).length, 1);
});

test("corrupt lines are ignored; missing store → []", async () => {
  const store = tmpStore();
  await writeFile(
    store,
    "not json\n" +
      JSON.stringify(rec({ ts: new Date(NOW - 20 * 60_000).toISOString(), state: "held", direction: "out" })) +
      "\n",
    "utf8",
  );
  assert.equal((await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN })).length, 1);
  assert.deepEqual(await findStaleThreads({ store: join(tmpdir(), "no-such-sweep-store.jsonl"), now: NOW }), []);
});

test("oldest first: the most urgent thread is on top", async () => {
  const store = tmpStore();
  await writeLedger(store, [
    rec({ phone: "15550000001", ts: new Date(NOW - 20 * 60_000).toISOString(), state: "held", direction: "out" }),
    rec({ phone: "15550000002", ts: new Date(NOW - 40 * 60_000).toISOString(), state: "held", direction: "out" }),
  ]);
  const stale = await findStaleThreads({ store, now: NOW, thresholdMs: FIFTEEN_MIN });
  assert.equal(stale.length, 2);
  assert.equal(stale[0].phone, "15550000002", "the older one is first");
});

test("buildStaleAlert: empty → '', with items → mentions the phone(s)", () => {
  assert.equal(buildStaleAlert([]), "");
  const msg = buildStaleAlert([
    { phone: PHONE, state: "held", ts: new Date(NOW).toISOString(), ageMs: 20 * 60_000, lastText: "x" },
  ]);
  assert.ok(msg.length > 0);
  assert.ok(msg.includes(PHONE));
});
