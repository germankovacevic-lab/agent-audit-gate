import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Append-only ledger path. CONFIG-DRIVEN via SWITCHBOARD_STORE; defaults to a
// file under the current user's home dir (never tied to a specific person).
const DEFAULT_STORE =
  process.env.SWITCHBOARD_STORE ??
  join(homedir(), ".switchboard", "switchboard.jsonl");

export type Direction = "in" | "out";
// pending   : inbound from a third party, awaiting handling.
// held      : channel draft HELD for the operator to audit (auditor mode).
// answered  : the operator released (sent) a deliberate reply.
// dropped   : the operator audited the draft and chose NOT to reply.
// suppressed: auto-reply cancelled without auditing (legacy / pure suppression).
// bot_loop  : flood/echo detected.
export type SwitchboardState =
  | "pending"
  | "held"
  | "answered"
  | "dropped"
  | "suppressed"
  | "bot_loop";

export type SwitchboardRecord = {
  ts: string;
  direction: Direction;
  phone: string;
  name?: string;
  jid?: string;
  text: string;
  state: SwitchboardState;
};

async function appendRecord(rec: SwitchboardRecord, store: string): Promise<void> {
  await appendFile(store, JSON.stringify(rec) + "\n", "utf8");
}

// INBOUND from a third party → opens/reopens the thread as 'pending'.
export async function captureInbound(
  rec: Omit<SwitchboardRecord, "ts" | "direction" | "state">,
  store: string = DEFAULT_STORE,
): Promise<void> {
  await appendRecord(
    { ts: new Date().toISOString(), direction: "in", state: "pending", ...rec },
    store,
  );
}

// OUTBOUND → records an outgoing event with its state:
//  - 'held'      : draft held for auditing (not sent).
//  - 'answered'  : deliberate send by the operator that passed the hook.
//  - 'dropped'   : the operator audited and chose not to reply.
//  - 'suppressed': auto-reply cancelled without auditing (legacy).
export async function captureOutbound(
  rec: Omit<SwitchboardRecord, "ts" | "direction" | "state">,
  state: Extract<SwitchboardState, "held" | "answered" | "dropped" | "suppressed">,
  store: string = DEFAULT_STORE,
): Promise<void> {
  await appendRecord(
    { ts: new Date().toISOString(), direction: "out", state, ...rec },
    store,
  );
}

// Returns the text of the LAST inbound from a phone: the third party's message
// that the held draft is replying to. Used to enrich the audit notification
// with the original context. Returns '' if there is no inbound or no store.
export async function lastInboundText(phone: string, store: string = DEFAULT_STORE): Promise<string> {
  let raw = "";
  try {
    raw = await readFile(store, "utf8");
  } catch {
    return "";
  }
  let found = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: SwitchboardRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.direction === "in" && rec.phone === phone) found = rec.text ?? "";
  }
  return found;
}

export type ThreadState = { phone: string; state: SwitchboardState; ts: string; lastText: string };

// Derives the live state of each thread from the append-only ledger:
// the last event per phone wins. A new inbound reopens ('pending');
// suppressed/answered close it. Keeps the ledger readable at a glance.
export async function deriveThreads(store: string = DEFAULT_STORE): Promise<Map<string, ThreadState>> {
  let raw = "";
  try {
    raw = await readFile(store, "utf8");
  } catch {
    return new Map();
  }
  const threads = new Map<string, ThreadState>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: SwitchboardRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec?.phone) continue;
    threads.set(rec.phone, { phone: rec.phone, state: rec.state, ts: rec.ts, lastText: rec.text });
  }
  return threads;
}
