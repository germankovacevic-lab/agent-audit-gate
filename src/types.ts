// Minimal, honest interfaces for the loosely-typed objects the OpenClaw plugin
// SDK hands us. These describe only the fields this plugin ACTUALLY reads — they
// are deliberately partial (all-optional), because the host may or may not
// populate a given field depending on the channel and the wiring. Types are
// stripped at runtime (no tsc step), so this is for readability/signal only; it
// changes nothing about behavior.

// Payload delivered by the `message_received` / `message_sending` hooks.
// Different channels populate different subsets, so every field is optional and
// the handlers read with `??` fallbacks.
export interface ChannelEvent {
  channel?: string;
  senderId?: string;
  from?: string;
  content?: string;
  sessionKey?: string;
  to?: string;
  recipient?: string;
  jid?: string;
}

// Hook context. On an auto-reply, `senderId` is present (this is the
// distinguisher between an auto-reply and a deliberate operator send).
export interface HookContext {
  channelId?: string;
  senderId?: string;
  sessionKey?: string;
}

// The slice of the gateway/plugin config we read to resolve the loopback wake
// endpoint. Anything we don't touch is intentionally omitted.
export interface GatewayConfig {
  hooks?: {
    enabled?: boolean;
    token?: string;
    path?: string;
  };
  gateway?: {
    port?: number;
  };
}

// One possible host of `enqueueNextTurnInjection` (the passive fallback). The SDK
// exposes this method on different objects depending on how the plugin is wired,
// so we probe a few candidates (see fallbackEnqueue in notify.ts).
export interface InjectionHost {
  enqueueNextTurnInjection?: (arg: { sessionKey: string; text: string }) => unknown;
}

// The subset of the plugin API surface this plugin uses. `config` is read to
// resolve the wake endpoint; the rest are probed as possible injection hosts.
export interface PluginApi extends InjectionHost {
  config?: GatewayConfig;
  session?: InjectionHost & { workflow?: InjectionHost };
  runtime?: InjectionHost;
}
