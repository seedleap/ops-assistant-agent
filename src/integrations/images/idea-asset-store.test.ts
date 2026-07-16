import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { ideaAssetKey } from "./idea-asset-store.js";

test("ideaAssetKey is tenant and workflow scoped", () => {
  const config = loadConfig({ IDEA_ASSET_S3_PREFIX: "generated/ideas" });
  assert.equal(
    ideaAssetKey(config.ideaAssets, {
      userId: "User / 123",
      projectId: "Project 456",
      workflowId: "idea_abc",
      ideaId: "Idea One",
    }),
    "generated/ideas/user-123/project-456/idea_abc/idea-one.png",
  );
});
