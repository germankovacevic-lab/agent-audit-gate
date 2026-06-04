// Allowlist of numbers that are NOT third parties: the operator's own
// verified line(s) plus the agent's own line. These are the only numbers
// that bypass the audit gate and flow through the channel normally.
//
// The allowlist is CONFIG-DRIVEN: it is read from the SWITCHBOARD_OWN_NUMBERS
// environment variable (comma-separated, digits only) so no real phone number
// is ever hardcoded. Example:
//
//   SWITCHBOARD_OWN_NUMBERS="15551230001,15551230002"
//
// Any number not in the allowlist is treated as a third party. An unknown /
// empty sender is also treated as a third party (fail-safe by default).

export function normalizePhone(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/@.*$/, "").replace(/\D/g, "");
}

// Parse the operator/agent allowlist from an env var (comma-separated).
export function loadOwnNumbers(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.SWITCHBOARD_OWN_NUMBERS ?? "";
  const nums = raw
    .split(",")
    .map((s) => normalizePhone(s))
    .filter((s) => s.length > 0);
  return new Set(nums);
}

// `ownNumbers` is injectable for tests; in production it defaults to the
// allowlist loaded from SWITCHBOARD_OWN_NUMBERS at call time.
export function isThirdParty(
  senderId: string | undefined,
  ownNumbers: Set<string> = loadOwnNumbers(),
): boolean {
  const n = normalizePhone(senderId);
  if (!n) return true; // unknown sender → treat as third party (fail-safe)
  return !ownNumbers.has(n);
}
