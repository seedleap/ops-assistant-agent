import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
import test from "node:test";
import { conversationKey, conversationWorkDir } from "./paths.js";

test("conversation workspace keys cannot escape the data directory", () => {
  const dataDir = "/var/lib/ops-agent/data";
  const workDir = conversationWorkDir(dataDir, "../../etc", "../passwd", "interactive");
  const relativePath = relative(dataDir, workDir);

  assert.equal(isAbsolute(relativePath), false);
  assert.equal(relativePath.split("/").includes(".."), false);
  assert.match(conversationKey("../../etc", "../passwd"), /^[a-f0-9]{32}$/);
});
