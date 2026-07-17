import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAddress } from "../src/util.js";

test("isValidAddress accepts a well-formed 0x-prefixed 40-hex-character address", () => {
  assert.equal(isValidAddress("0x1234567890abcdef1234567890ABCDEF12345678"), true);
});

test("isValidAddress rejects a missing 0x prefix", () => {
  assert.equal(isValidAddress("1234567890abcdef1234567890abcdef12345678"), false);
});

test("isValidAddress rejects the wrong length", () => {
  assert.equal(isValidAddress("0x1234"), false);
  assert.equal(isValidAddress("0x1234567890abcdef1234567890abcdef123456789"), false);
});

test("isValidAddress rejects non-hex characters", () => {
  assert.equal(isValidAddress("0xzzzz567890abcdef1234567890abcdef12345678"), false);
});
