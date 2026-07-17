import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { ideaAssetKey } from "./idea-asset-store.js";

test("ideaAssetKey isolates generated images under the workflow directory", () => {
  const config = loadConfig();
  assert.equal(
    ideaAssetKey(config.ideaAssets, {
      userId: "User / 123",
      projectId: "Project 456",
      workflowId: "idea_abc",
      ideaId: "Idea One",
    }),
    "lab/ideas/idea_abc/idea-one.png",
  );
});

test("ideaAssetKey does not mix project ids into the lab asset namespace", () => {
  const config = loadConfig();
  assert.equal(
    ideaAssetKey(config.ideaAssets, {
      userId: "user-123",
      workflowId: "idea-abc",
      ideaId: "idea-one",
    }),
    "lab/ideas/idea-abc/idea-one.png",
  );
});
