import { isThirdParty, normalizePhone } from "./verified.ts";
import { captureInbound, captureOutbound, lastInboundText } from "./capture.ts";
import { isDuplicateInbound } from "./dedup.ts";
import { notifyAudit } from "./notify.ts";
import type { ChannelEvent, HookContext, PluginApi } from "./types.ts";

// Injectable deps for tests (temp store, fake notify/dbg). In production these
// use the defaults: real ledger, real notifyAudit, dbg provided by index.ts.
export type AuditNotify = (
  api: PluginApi,
  opts: { phone: string; inbound: string; draft: string; name?: string },
) => Promise<void>;

export type Deps = {
  store?: string;
  notify?: AuditNotify;
  dbg?: (obj: unknown) => void;
};

const noop = () => {};

// INBOUND: captures the third party's message as data ('pending'). Does NOT wake
// the operator's main session: in auditor mode the wake arrives when the channel
// generates the draft (handleSending → notifyAudit), which carries inbound + draft
// together. With dmPolicy=open the draft is always generated; the inbound stays in
// the ledger with full context.
export async function handleInbound(
  api: PluginApi,
  event: ChannelEvent,
  ctx: HookContext,
  deps: Deps = {},
): Promise<void> {
  const dbg = deps.dbg ?? noop;
  const channel = event?.channel ?? ctx?.channelId;
  if (channel !== "whatsapp") return;
  const sender = event?.senderId ?? event?.from ?? ctx?.senderId;
  if (!isThirdParty(sender)) return; // operator / agent's own line → normal flow
  const sessionKey: string = event?.sessionKey ?? ctx?.sessionKey ?? "";
  if (sessionKey.includes(":group:")) return; // 1:1 DMs only

  const phone = normalizePhone(sender);
  const text = String(event?.content ?? "").trim();

  // Dedup: broken-bot flood / identical double-send → do not capture.
  if (isDuplicateInbound(phone, text)) {
    dbg({ phase: "deduped_flood", phone, text: text.slice(0, 40) });
    return;
  }

  try {
    await captureInbound({ phone, jid: String(sender), text }, deps.store);
  } catch (err) {
    dbg({ phase: "capture_err", err: String(err) });
  }
  dbg({ phase: "captured_inbound", phone, text: text.slice(0, 60) });
}

// OUTBOUND: the auto-reply to third parties is NOT sent — it is HELD ('held') and
// the operator's main session is woken to audit it. Distinguisher: the auto-reply
// carries ctx.senderId; the operator's deliberate sends (message send) do NOT → they pass.
// Returns { cancel: true } to stop the auto-reply; undefined lets it through.
export async function handleSending(
  api: PluginApi,
  event: ChannelEvent,
  ctx: HookContext,
  deps: Deps = {},
): Promise<{ cancel: true; cancelReason: string } | undefined> {
  const dbg = deps.dbg ?? noop;
  const notify = deps.notify ?? notifyAudit;
  const channel = event?.channel ?? ctx?.channelId;
  if (channel !== "whatsapp") return;
  const text = String(event?.content ?? "").trim();
  const sender = ctx?.senderId; // present only on auto-reply

  if (sender) {
    // AUTO-REPLY to a third party → hold the draft + wake the operator to audit.
    if (!isThirdParty(sender)) return; // operator / agent's own line → allow
    const phone = normalizePhone(sender);
    try {
      await captureOutbound({ phone, jid: String(sender), text }, "held", deps.store);
      const inbound = await lastInboundText(phone, deps.store);
      await notify(api, { phone, inbound, draft: text });
    } catch (err) {
      dbg({ phase: "hold_err", err: String(err) });
    }
    dbg({ phase: "held_draft", to: phone, draft: text.slice(0, 60) });
    return { cancel: true, cancelReason: "switchboard: draft held for audit (operator releases deliberately)" };
  }

  // DELIBERATE SEND (no ctx.senderId): ALWAYS allow. If it goes to a third party,
  // close the thread as 'answered'. Best-effort — never cancels or breaks the send.
  try {
    const sk: string = event?.sessionKey ?? ctx?.sessionKey ?? "";
    const to = event?.to ?? event?.recipient ?? event?.jid ?? sk;
    const phone = normalizePhone(typeof to === "string" ? to : "");
    if (phone && isThirdParty(phone)) {
      await captureOutbound({ phone, jid: String(to), text }, "answered", deps.store);
      dbg({ phase: "answered_deliberate", to: phone });
    }
  } catch (err) {
    dbg({ phase: "answered_log_err", err: String(err) });
  }
  return;
}
