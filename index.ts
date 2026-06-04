import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync } from "node:fs";
import { handleInbound, handleSending } from "./src/handlers.ts";
import type { ChannelEvent, HookContext } from "./src/types.ts";

// Debug logging is OPT-IN and OFF by default. Diagnostic events can include
// phone numbers and message snippets, so we never write them to disk unless the
// operator explicitly sets SWITCHBOARD_DEBUG_LOG to a writable file path.
// (Leaving it unset means dbg() is a no-op — no third-party data hits the disk.)
const DEBUG_PATH = process.env.SWITCHBOARD_DEBUG_LOG;

function dbg(obj: unknown): void {
  if (!DEBUG_PATH) return;
  try {
    appendFileSync(DEBUG_PATH, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`, "utf8");
  } catch {
    /* noop */
  }
}

// AUDITOR mode: the third party enters as data; the channel's draft is HELD
// ('held') and the operator's main session is woken to audit it; the operator
// releases it with a deliberate `message send`. The logic lives in
// src/handlers.ts (testable); here we only wire the hooks.
export default definePluginEntry({
  id: "switchboard", // runtime/config id = codename (plugins.entries.switchboard); display name below
  name: "Agent Audit Gate",
  description: "Third-party WhatsApp DMs: capture as data + hold auto-reply draft for a senior reviewer to audit.",
  // `api` is the plugin SDK handle (definePluginEntry's register callback). Its
  // full shape is owned by the SDK; we only call `api.on(...)` and pass it
  // through to the handlers, so we keep it dynamic here — the SDK trust boundary.
  register(api) {
    dbg({ phase: "register" });

    // INBOUND: capture the third party's message as 'pending' (does not wake;
    // the wake arrives with the draft in handleSending).
    api.on(
      "message_received",
      (event: ChannelEvent, ctx: HookContext) => handleInbound(api, event, ctx, { dbg }),
      { priority: 100 },
    );

    // OUTBOUND: hold the auto-reply draft ('held') + wake the operator's main
    // session to audit; let the operator's deliberate sends pass ('answered').
    api.on(
      "message_sending",
      (event: ChannelEvent, ctx: HookContext) => handleSending(api, event, ctx, { dbg }),
      { priority: 100 },
    );
  },
});
