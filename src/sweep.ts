import { homedir } from "node:os";
import { join } from "node:path";
import { deriveThreads, type SwitchboardState } from "./capture.ts";

// Same default ledger path as capture.ts (CONFIG-DRIVEN via SWITCHBOARD_STORE).
const DEFAULT_STORE =
  process.env.SWITCHBOARD_STORE ??
  join(homedir(), ".switchboard", "switchboard.jsonl");

// How long a thread may wait before it counts as stale. CONFIG-DRIVEN via
// SWITCHBOARD_STALE_MS; defaults to 15 minutes. If a draft stays 'held' (or an
// inbound stays 'pending') longer than this, something broke — the real-time
// wake AND the enqueue fallback both failed, or nobody audited it — and the
// thread is stuck with no notification. This sweep is that safety net.
const DEFAULT_THRESHOLD_MS = (() => {
  const n = Number(process.env.SWITCHBOARD_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
})();

// States that mean "still waiting for the reviewer". The rest are closed
// (answered/dropped/suppressed/bot_loop) → never reported.
const STALE_STATES: ReadonlySet<SwitchboardState> = new Set<SwitchboardState>(["held", "pending"]);

export type StaleThread = {
  phone: string;
  state: SwitchboardState; // always 'held' or 'pending'
  ts: string; // ISO timestamp of the last (stuck) event
  ageMs: number; // how long it has been stuck, relative to `now`
  lastText: string; // text of the last event (held draft or pending inbound)
};

export type FindStaleOpts = {
  store?: string;
  now?: number;
  thresholdMs?: number;
};

// Read-only sweep of the ledger: derives the live state per phone and reports the
// threads whose LAST event is held/pending and has aged past the threshold. The
// last event wins (deriveThreads resolves that), so a 'held' later closed by an
// 'answered' does NOT show up. Missing/empty store → []. Corrupt lines are ignored.
export async function findStaleThreads(opts: FindStaleOpts = {}): Promise<StaleThread[]> {
  const store = opts.store ?? DEFAULT_STORE;
  const now = opts.now ?? Date.now();
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;

  const threads = await deriveThreads(store);
  const stale: StaleThread[] = [];
  for (const t of threads.values()) {
    if (!STALE_STATES.has(t.state)) continue;
    const ageMs = now - Date.parse(t.ts);
    // strict `>`: exactly at the threshold is not yet considered stuck.
    if (ageMs > thresholdMs) {
      stale.push({ phone: t.phone, state: t.state, ts: t.ts, ageMs, lastText: t.lastText });
    }
  }
  // Oldest first: the most urgent to audit on top.
  stale.sort((a, b) => b.ageMs - a.ageMs);
  return stale;
}

// Concise alert for the operator. Returns the string only — nothing is written to
// disk (it may carry third-party text; the caller decides where it goes). No stale
// threads → '' (the caller sends nothing).
export function buildStaleAlert(stale: StaleThread[]): string {
  if (stale.length === 0) return "";
  const line = (s: StaleThread) => {
    const min = Math.round(s.ageMs / 60_000);
    const label = s.state === "held" ? "held draft" : "unanswered inbound";
    return `- ${s.phone} (${label}, ${min} min)`;
  };
  const count = stale.length === 1 ? "1 stuck thread" : `${stale.length} stuck threads`;
  return [
    `Switchboard: ${count} in the ledger (not audited in time):`,
    ...stale.map(line),
    "Audit and release/drop each one.",
  ].join("\n");
}
