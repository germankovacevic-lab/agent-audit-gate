# Switchboard — an audit gate for AI agent outbound messaging

An [OpenClaw](https://openclaw.ai) plugin that puts a **human-or-senior-reviewer audit gate**
in front of everything an AI agent would auto-send to a third party on a 1:1 channel.

> **"Junior drafts, senior approves."**

This is a **reference implementation** of a pattern, not a turnkey product. It is small and
readable on purpose: read the source, take the idea, adapt it to your own deployment.

## The problem

If you put an LLM-driven agent on a public messaging channel (e.g. a WhatsApp line with an
"open DM" policy that auto-replies to anyone), you inherit two classic failure modes:

1. **Leakage** — the model reveals internal context (private data, projects, contacts, your
   system prompt, which model/tools you run) because someone simply asked.
2. **Prompt injection** — a stranger's message is treated as an instruction instead of as
   data, and the agent does something it shouldn't.

You usually *cannot* stop the model from **generating** a reply — by the time you'd want to
intervene, the draft already exists. So instead of letting it go out, Switchboard **holds**
the draft and routes it to a separate **reviewer** session that audits it against your rules
before it is released **deliberately**.

The operator's own number(s) and the agent's own line are exempt: they flow through normally.

## How it works

Two edge I/O hooks (`priority: 100`). The logic lives in `src/handlers.ts` (testable);
`index.ts` only wires the hooks.

- **`message_received`** (`handleInbound`) — a 1:1 WhatsApp DM from a third party is written
  to the ledger as `pending`. It does **not** wake the reviewer on its own; the wake arrives
  together with the draft (next step), so the reviewer sees the inbound and the draft at once.
- **`message_sending`** (`handleSending`):
  - **auto-reply to a third party** (`ctx.senderId` is present) → the draft is **held**
    (`held`), `notifyAudit({ phone, inbound, draft })` wakes the **reviewer** session in
    real time, and the send is **cancelled** (the draft does not leave the machine).
  - **deliberate send** (your `message send`, no `ctx.senderId`) → **always passes**; if it
    targets a third party it is recorded as `answered`. Best-effort — it never cancels or
    breaks a deliberate send.

The key distinguisher: an **auto-reply carries `ctx.senderId`**; a deliberate send does not.

### The "held" lifecycle

The ledger is append-only, one line per event. The live state of each thread is **derived**
(`deriveThreads()`): the last event per phone wins.

```
inbound  → pending     (opens / reopens the thread)
draft    → held        (auto-reply held, awaiting audit)
release  → answered    (reviewer audited and released deliberately)
drop     → dropped     (reviewer audited and chose not to reply)
```

(`suppressed` is a legacy state for pure suppression with no audit step.)
A new inbound after a closed thread **reopens** it as `pending`.

### The audit notification — `src/notify.ts`

`notifyAudit` wakes the reviewer session with an audit prompt (`buildAuditText`: who wrote,
what they said, what the channel drafted, and how to release). The prompt is a **generic
reference checklist** — adapt the policy wording to your own deployment.

- **Preferred:** `POST /hooks/wake` (loopback, real-time, event-driven, no polling).
- **Fallback:** `enqueueNextTurnInjection` (passive, picked up on the reviewer's next turn).

### Third-party detection — `src/verified.ts`

`isThirdParty()` treats as a third party any number that is **not** in the operator/agent
allowlist. The allowlist is config-driven (see below). An unknown/empty sender is also a
third party — **fail-safe by default**.

## Install

This is an OpenClaw plugin. Install it straight from this repo:

```bash
openclaw plugins install git:github.com/germankovacevic-lab/agent-audit-gate
```

Or clone and link it for local development:

```bash
git clone https://github.com/germankovacevic-lab/agent-audit-gate
openclaw plugins install --link ./agent-audit-gate
```

Then set the environment variables below and restart the gateway.

## Configuration

All deployment-specific values are read from environment variables; no real numbers, names,
or paths are hardcoded.

| Env var                     | Purpose                                                                 | Default                                  |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `SWITCHBOARD_OWN_NUMBERS`   | Comma-separated allowlist of the operator's/agent's own numbers (digits). Numbers **not** here are third parties. | *(empty → everyone is a third party)*    |
| `SWITCHBOARD_STORE`         | Path to the append-only JSONL ledger.                                   | `~/.switchboard/switchboard.jsonl`       |
| `SWITCHBOARD_AUDIT_SESSION` | Session key of the reviewer session that audits held drafts.            | `agent:main:main`                        |
| `SWITCHBOARD_CONFIG_PATH`   | Gateway config file, read only to obtain the loopback hooks token.      | `~/.openclaw/openclaw.json`              |
| `SWITCHBOARD_DEBUG_LOG`     | Optional path for opt-in debug logging. **Unset = no logging** (so no third-party data ever touches disk). | *(unset → disabled)*                     |

Example:

```bash
export SWITCHBOARD_OWN_NUMBERS="15551230001,15551230002"
export SWITCHBOARD_STORE="$HOME/.switchboard/switchboard.jsonl"
```

In the OpenClaw gateway, enable the plugin with
`plugins.entries.switchboard.enabled = true` plus the plugin path in `plugins.load.paths`.

It does **not** need `allowConversationAccess`: it uses only the edge I/O hooks
`message_received` / `message_sending`, which do not require conversation access.

## Tests

```bash
node --test test/*.test.ts
```

Covers: `verified` (third-party detection + config-driven allowlist), `capture`
(ledger + `held`/`dropped` + `lastInboundText`), `dedup` (flood/echo suppression),
`notify` (`buildAuditText` + `resolveWakeEndpoint` + a real POST to a loopback test server),
and `handlers` (the glue for both hooks with injectable deps).

> ⚠️ **Test side-effect to be aware of:** `resolveWakeEndpoint` falls back to reading the real
> gateway config from disk when `api.config.hooks` is not wired — a test with a bare `api`
> could POST a wake to a **live** gateway. Guard rails: (a) the `notify`/`handlers` tests set
> `NODE_ENV=test` (which never reads disk), and (b) they always pass `config.hooks` explicitly
> or inject a fake `notify`.

## Known limitations / not included

- **Config-level fail-safe:** with an open DM policy, if the plugin is down the auto-reply
  returns. Pair it with a floor-level allowlist (plugin down = silence, not leak).
- **Optional safety net:** if the auto-reply is ever suppressed upstream (no draft → no wake),
  the inbound sits `pending` in the ledger but fires no notification. A timeout that wakes on
  stale `pending` entries would close that gap.

This is a **reference implementation**. It demonstrates the pattern honestly; it is not a
hardened, supported product. Read it, fork it, adapt it.

## License

MIT — see [LICENSE](./LICENSE).
