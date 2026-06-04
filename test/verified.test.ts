import { test } from "node:test";
import assert from "node:assert/strict";
import { isThirdParty, normalizePhone, loadOwnNumbers } from "../src/verified.ts";

// Obviously-fake placeholder numbers (E.164-ish, never real).
const OWN_VERIFIED = "15551230001"; // the operator's own verified line
const OWN_AGENT = "15551230002"; // the agent's own line
const STRANGER = "15555550000"; // some third party
const OWN = new Set([OWN_VERIFIED, OWN_AGENT]);

test("normalizePhone keeps digits only", () => {
  assert.equal(normalizePhone("+1 555 123 0001"), "15551230001");
  assert.equal(normalizePhone("15551230001@s.whatsapp.net"), "15551230001");
});

test("loadOwnNumbers parses a comma-separated env allowlist", () => {
  const set = loadOwnNumbers({ SWITCHBOARD_OWN_NUMBERS: "+1 555 123 0001, 15551230002" } as any);
  assert.equal(set.has("15551230001"), true);
  assert.equal(set.has("15551230002"), true);
  assert.equal(set.size, 2);
});

test("the operator's verified number is NOT a third party", () => {
  assert.equal(isThirdParty(`${OWN_VERIFIED}@s.whatsapp.net`, OWN), false);
  assert.equal(isThirdParty(`+${OWN_VERIFIED}`, OWN), false);
});

test("the agent's own line is NOT a third party (do not self-manage)", () => {
  assert.equal(isThirdParty(`${OWN_AGENT}@s.whatsapp.net`, OWN), false);
});

test("any other number IS a third party", () => {
  assert.equal(isThirdParty(`${STRANGER}@s.whatsapp.net`, OWN), true);
  assert.equal(isThirdParty(undefined, OWN), true); // unknown sender = third party (fail-safe)
});

test("empty allowlist → everyone is a third party", () => {
  assert.equal(isThirdParty(`${OWN_VERIFIED}@s.whatsapp.net`, new Set()), true);
});
