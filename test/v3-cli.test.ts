import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory } from "../src/v3-cli.js";

function withTmpDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "aero-v3-cli-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readHistory: null when the file doesn't exist", () => {
  withTmpDir((dir) => {
    assert.equal(readHistory(join(dir, "missing.json")), null);
  });
});

test("readHistory: parses a valid history file", () => {
  withTmpDir((dir) => {
    const path = join(dir, "v3-history.json");
    const file = { at: ["2026-11-20T00:00:00.000Z"], pools: { "base:0xa": [1] } };
    writeFileSync(path, JSON.stringify(file));
    assert.deepEqual(readHistory(path), file);
  });
});

test("readHistory: falls back to null, not a throw, on truncated/corrupt JSON", () => {
  withTmpDir((dir) => {
    const path = join(dir, "v3-history.json");
    writeFileSync(path, '{"at": ["2026-11-20T00:00:00.000Z"], "pools": {"base:0xa"');
    assert.equal(readHistory(path), null);
  });
});
