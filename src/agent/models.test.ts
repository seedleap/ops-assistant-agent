import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { OpsModelRegistry } from "./models.js";

test("Idea text agent registers the shared Azure credential with Pi", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ops-model-auth-"));
  try {
    const config = loadConfig({
      ASSISTANT_DRY_RUN: "true",
      DATA_DIR: dataDir,
      IDEA_IMAGE_API_KEY: "shared-azure-key",
      IDEA_IMAGE_BASE_URL: "https://shared-resource.cognitiveservices.azure.com",
    });
    const models = await OpsModelRegistry.create(config);
    const model = models.resolve("azure-openai-responses", "gpt-5.5");
    const auth = await models.registry.getApiKeyAndHeaders(model);

    assert.equal(auth.ok, true);
    if (auth.ok) assert.equal(auth.apiKey, "shared-azure-key");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
