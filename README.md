# Agent Audit Gate

*(Internally codenamed **Switchboard** — that's why the plugin id, the ledger file, and the `SWITCHBOARD_` env vars carry that name.)*

An [OpenClaw](https://openclaw.ai) plugin that puts an **AI-in-the-loop audit gate**
in front of everything an AI agent would auto-send to a third party on a 1:1 channel —
the reviewer is a **senior agent, not a human** (escalating to you only when it matters).

> **"Junior drafts, senior approves."**

This is a **reference implementation** of a pattern, not a turnkey product. It is small and
readable on purpose: read the source, take the idea, and adapt it — the audit policy and the
channels are env-configurable, so the common cases need no fork.

Built by **[AgentNeo](https://agneo.app)** — AI agents with operational rigor, and the open-source safety patterns to run them.

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

## Why this is different

Human-in-the-loop approval gates are a well-established pattern — there is nothing novel
about holding an action for sign-off. The twist here is that the reviewer is a **senior AI
agent, not a human**: AI-in-the-loop. The draft is held and a *second* agent — one with more
context and a security focus — audits it before release. That is what makes it scale: no
human has to read every message, and the senior reviewer has context the channel session
lacks (operator data, project boundaries, what counts as a leak).

I couldn't find another plugin in the OpenClaw ecosystem (ClawHub, docs) that audits outbound
**channel messages**. Lobster and similar gate workflow side-effects; this gates the actual
messages a stranger can trigger — the words that leave the machine and land on someone's phone.

## How it works

```text
third-party 1:1 DM
      │
      ▼
message_received   ──►  ledger: pending     (reviewer NOT woken yet)
      │
      ▼
agent auto-drafts a reply
      │
      ▼
message_sending    ──►  HELD                (draft is NOT sent)
      │
      ▼
wake reviewer  ◄──  carries the inbound + the draft
      │
      ▼
reviewer audits ──┬──►  RELEASE → deliberate send → answered
                  └──►  DROP    → dropped (nothing sent)
```

> The operator's own number(s) bypass the gate and flow through normally.
> If a `held`/`pending` thread is never audited, the [stale-thread sweep](#safety-net--stale-thread-sweep) flags it.

Two edge I/O hooks (`priority: 100`). The logic lives in `src/handlers.ts` (testable);
`index.ts` only wires the hooks.

- **`message_received`** (`handleInbound`) — a 1:1 DM from a third party (WhatsApp by default;
  any channel via `SWITCHBOARD_CHANNELS`) is written to the ledger as `pending`. It does **not** wake the reviewer on its own; the wake arrives
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
| `SWITCHBOARD_CHANNELS`      | Comma-separated 1:1 messaging channels the plugin intercepts.           | `whatsapp`                               |
| `SWITCHBOARD_AUDIT_POLICY`  | Overrides the audit checklist the reviewer applies to a held draft.     | *(built-in generic gate)*                |
| `SWITCHBOARD_RELEASE_CHANNEL` | Channel shown in the release command inside the audit text. Defaults to the first `SWITCHBOARD_CHANNELS` entry, else `whatsapp`. | `whatsapp`                               |
| `SWITCHBOARD_STALE_MS`      | Age after which a `held`/`pending` thread is reported by the [stale-thread sweep](#safety-net--stale-thread-sweep). | `900000` (15 min)                        |

Example:

```bash
export SWITCHBOARD_OWN_NUMBERS="15551230001,15551230002"
export SWITCHBOARD_STORE="$HOME/.switchboard/switchboard.jsonl"
```

In the OpenClaw gateway, enable the plugin with
`plugins.entries.switchboard.enabled = true` plus the plugin path in `plugins.load.paths`.

It does **not** need `allowConversationAccess`: it uses only the edge I/O hooks
`message_received` / `message_sending`, which do not require conversation access.

## Safety net — stale-thread sweep

The real-time wake (and its passive `enqueueNextTurnInjection` fallback) can *both* fail —
gateway down, hooks misconfigured, no reviewer turn. When that happens a draft sits `held`
(or an inbound sits `pending`) in the ledger forever, and nobody is told. `src/sweep.ts`
closes that gap: a **pure, read-only** function that finds threads stuck past a threshold so
you can alert on them.

```ts
import { findStaleThreads, buildStaleAlert } from "./src/sweep.ts";

// Run this on YOUR scheduler (cron, a heartbeat tick — the plugin starts no timers itself).
const stale = await findStaleThreads(); // held/pending older than SWITCHBOARD_STALE_MS (default 15m)
if (stale.length) {
  // buildStaleAlert returns a string only — nothing is written to disk.
  await notifyOperator(buildStaleAlert(stale));
}
```

Closed states (`answered`/`dropped`/`suppressed`/`bot_loop`) are never reported; the last event
per thread wins, so a released draft drops off automatically. Make the alert path independent of
the wake path it is backing up — if you wake a reviewer to deliver it, you have re-introduced the
single point of failure this is meant to cover.

## Tests

```bash
node --test test/*.test.ts
```

Covers: `verified` (third-party detection + config-driven allowlist), `capture`
(ledger + `held`/`dropped` + `lastInboundText`), `dedup` (flood/echo suppression),
`notify` (`buildAuditText` + `resolveWakeEndpoint` + a real POST to a loopback test server),
`handlers` (the glue for both hooks with injectable deps), and `sweep` (stale-thread detection
+ alert, with a fixed clock and temp ledgers).

> ⚠️ **Test side-effect to be aware of:** `resolveWakeEndpoint` falls back to reading the real
> gateway config from disk when `api.config.hooks` is not wired — a test with a bare `api`
> could POST a wake to a **live** gateway. Guard rails: (a) the `notify`/`handlers` tests set
> `NODE_ENV=test` (which never reads disk), and (b) they always pass `config.hooks` explicitly
> or inject a fake `notify`.

## Known limitations / not included

- **Config-level fail-safe:** with an open DM policy, if the plugin is down the auto-reply
  returns. Pair it with a floor-level allowlist (plugin down = silence, not leak).
- **Scheduler not bundled:** the stale-thread safety net ([below](#safety-net--stale-thread-sweep))
  ships as a pure function, not a running timer — you wire it to your own scheduler (cron, a
  heartbeat, etc.). The plugin does not start background timers on its own, by design.

This is a **reference implementation**. It demonstrates the pattern honestly; it is not a
hardened, supported product. Read it, fork it, adapt it.

## License

MIT — see [LICENSE](./LICENSE).

## About

Built and maintained by **[AgentNeo](https://agneo.app)** — we build AI agents with operational rigor and open-source the safety patterns needed to run them in the real world.
