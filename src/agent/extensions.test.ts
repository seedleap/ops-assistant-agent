import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createModelParametersExtension } from "./extensions.js";
import type { AgentProfile } from "./profiles/types.js";

const PROFILE: AgentProfile = {
  id: "creator-chat",
  traceName: "ops-creator-chat",
  prompt: {
    version: "creator-support-v4",
    fileName: "creator-chat.md",
    file: "/tmp/creator-chat.md",
  },
  model: {
    provider: "google-vertex",
    modelId: "gemini-3-flash-preview",
    thinkingLevel: "low",
    temperature: 0.3,
  },
  runtime: {
    maxTurns: 10,
    timeoutMs: 120_000,
    maxRetries: 2,
    compactionEnabled: true,
  },
  toolNames: ["creator_work_analyze"],
  runType: "interactive",
  skills: [],
};

test("model parameters extension patches Vertex payload without enabling thoughts", () => {
  let handler: ((event: { payload: unknown }) => unknown) | undefined;
  const pi = {
    on(event: string, callback: (event: { payload: unknown }) => unknown) {
      if (event === "before_provider_request") handler = callback;
    },
  } as unknown as ExtensionAPI;

  createModelParametersExtension(PROFILE)(pi);
  const result = handler?.({
    payload: {
      model: PROFILE.model.modelId,
      config: { thinkingConfig: { thinkingLevel: "LOW" } },
    },
  }) as { config?: { temperature?: number; thinkingConfig?: Record<string, unknown> } };

  assert.equal(result.config?.temperature, 0.3);
  assert.deepEqual(result.config?.thinkingConfig, {
    thinkingLevel: "LOW",
    includeThoughts: false,
  });
});

test("latest Pi resource loader keeps explicit inline extensions when discovery is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-pi-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "test",
      extensionFactories: [{ name: "model-parameters", factory: () => {} }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().extensions.map((item) => item.path), ["<inline:model-parameters>"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi registers the standard SKILL.md directory in the system skill index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-pi-skill-"));
  try {
    const skillDir = join(dir, "creator-guide");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: creator-guide\ndescription: creator guidance\n---\n\n# Guide\n");
    const result = loadSkillsFromDir({ dir, source: "workspace" });
    assert.equal(result.skills.length, 1);
    assert.match(formatSkillsForPrompt(result.skills), /creator-guide/);
    assert.match(formatSkillsForPrompt(result.skills), /Use the read tool/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
