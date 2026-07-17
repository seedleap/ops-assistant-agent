import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../config.js";
import { ideaAssetKey } from "./idea-asset-store.js";

test("ideaAssetKey uses Carmack's authorized public dist layout", () => {
  const config = loadConfig();
  assert.equal(
    ideaAssetKey(config.ideaAssets, {
      userId: "User / 123",
      projectId: "Project 456",
      workflowId: "idea_abc",
      ideaId: "Idea One",
    }),
    "public/game/project-456/idea_abc/workspace/dist/ideas/idea-one.png",
  );
});

test("ideaAssetKey uses idea_create when projectId is omitted", () => {
  const config = loadConfig();
  assert.equal(
    ideaAssetKey(config.ideaAssets, {
      userId: "user-123",
      workflowId: "idea-abc",
      ideaId: "idea-one",
    }),
    "public/game/idea_create/idea-abc/workspace/dist/ideas/idea-one.png",
  );
});
