import { test } from "node:test";
import assert from "node:assert/strict";
import { isDuplicateInbound } from "../src/dedup.ts";

function freshStore() {
  return new Map<string, { text: string; ts: number }>();
}

test("first occurrence is NOT a duplicate", () => {
  const s = freshStore();
  assert.equal(isDuplicateInbound("15550000X", "Hi menu", 1000, 60000, s), false);
});

test("same text + same phone within the window IS a duplicate", () => {
  const s = freshStore();
  isDuplicateInbound("15550000X", "menu", 1000, 60000, s);
  assert.equal(isDuplicateInbound("15550000X", "menu", 5000, 60000, s), true);
});

test("sustained flood stays deduplicated (refreshes the window)", () => {
  const s = freshStore();
  isDuplicateInbound("15550000X", "menu", 0, 60000, s);
  assert.equal(isDuplicateInbound("15550000X", "menu", 30000, 60000, s), true);
  assert.equal(isDuplicateInbound("15550000X", "menu", 80000, 60000, s), true); // 50s after the previous one
});

test("same text but OUTSIDE the window is NOT a duplicate", () => {
  const s = freshStore();
  isDuplicateInbound("15550000X", "menu", 0, 60000, s);
  assert.equal(isDuplicateInbound("15550000X", "menu", 70000, 60000, s), false);
});

test("different text from the same phone is NOT a duplicate", () => {
  const s = freshStore();
  isDuplicateInbound("15550000X", "Hi", 1000, 60000, s);
  assert.equal(isDuplicateInbound("15550000X", "Something else", 2000, 60000, s), false);
});

test("same text from ANOTHER phone is NOT a duplicate", () => {
  const s = freshStore();
  isDuplicateInbound("15550000A", "menu", 1000, 60000, s);
  assert.equal(isDuplicateInbound("15550000B", "menu", 2000, 60000, s), false);
});
