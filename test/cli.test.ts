import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveIntFlag } from "../src/cli.js";

test("parsePositiveIntFlag returns the fallback when the flag is absent", () => {
  assert.equal(parsePositiveIntFlag([], "top", 20), 20);
});

test("parsePositiveIntFlag parses a valid positive integer flag", () => {
  assert.equal(parsePositiveIntFlag(["--top", "5"], "top", 20), 5);
});

test("parsePositiveIntFlag rejects a non-numeric value instead of returning NaN", () => {
  assert.equal(parsePositiveIntFlag(["--top", "abc"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects zero and negative values", () => {
  assert.equal(parsePositiveIntFlag(["--top", "0"], "top", 20), undefined);
  assert.equal(parsePositiveIntFlag(["--top", "-5"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects non-integer values", () => {
  assert.equal(parsePositiveIntFlag(["--top", "3.5"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects a dangling flag with no value instead of silently using the fallback", () => {
  assert.equal(parsePositiveIntFlag(["--top"], "top", 20), undefined);
  assert.equal(parsePositiveIntFlag(["--veaero", "25000", "--top"], "top", 20), undefined);
});
