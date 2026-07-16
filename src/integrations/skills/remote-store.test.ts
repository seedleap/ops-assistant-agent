import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSkillStore } from "./remote-store.js";

const disabled = new RemoteSkillStore({
  enabled: false,
  prefix: "skills",
  cacheDir: "/tmp/ops-skill-cache",
  timeoutMs: 1_000,
  maxBytes: 1024,
});

test("remote skill refs are validated before any remote request", async () => {
  await assert.rejects(
    disabled.materialize({ id: "Creator Growth", version: "latest" }, "/tmp/ops-skill"),
    /invalid remote skill id/,
  );
});

test("remote materialization is explicit and never falls back when disabled", async () => {
  await assert.rejects(
    disabled.materialize({ id: "creator-growth", version: "1.0.0" }, "/tmp/ops-skill"),
    /remote skill store is disabled/,
  );
});
