// Dedup of repeated identical inbound (broken-bot flood / double-send).
// If the SAME text from the SAME phone arrives within the window → echo/loop:
// do not capture or wake the reviewer. The 1st occurrence passes normally.

const DEFAULT_WINDOW_MS = 60_000;

type LastSeen = { text: string; ts: number };
const lastByPhone = new Map<string, LastSeen>();

export function isDuplicateInbound(
  phone: string,
  text: string,
  now: number = Date.now(),
  windowMs: number = DEFAULT_WINDOW_MS,
  store: Map<string, LastSeen> = lastByPhone,
): boolean {
  const prev = store.get(phone);
  const dup = !!prev && prev.text === text && now - prev.ts < windowMs;
  // always refresh: a sustained flood of the same text stays deduplicated
  store.set(phone, { text, ts: now });
  return dup;
}
