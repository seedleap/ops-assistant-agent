import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { createReadKnowledgeTool, knowledgeIndex } from "../knowledge.js";
import { createOpsDataTools } from "../opsDataTools.js";
import { RemoteOpsMcpClient } from "../opsMcpClient.js";
import type { AssistantRunInput } from "../types.js";
import { createAgentRunTrace, type AgentRunTrace } from "../observability/langfuse.js";
import type { Observability } from "../observability/index.js";
import { createModelParametersExtension, createTurnLimitExtension } from "./extensions.js";
import { OpsModelRegistry } from "./models.js";
import type { AgentProfile } from "./profiles/types.js";

export interface OpsSessionHandle {
  session: AgentSession;
  trace?: AgentRunTrace;
  modelName: string;
}

export class OpsSessionFactory {
  private modelsPromise?: Promise<OpsModelRegistry>;
  private readonly tools: ToolDefinition[];
  private readonly opsMcp: RemoteOpsMcpClient;

  constructor(
    private readonly config: AppConfig,
    private readonly observability: Observability,
  ) {
    this.opsMcp = new RemoteOpsMcpClient(config.opsMcp);
    this.tools = [
      ...createOpsDataTools(this.opsMcp),
      createReadKnowledgeTool(config.skillsDir),
    ];
  }

  close(): Promise<void> {
    return this.opsMcp.close();
  }

  async create(profile: AgentProfile, input: AssistantRunInput): Promise<OpsSessionHandle> {
    await mkdir(input.workDir, { recursive: true });
    await mkdir(input.sessionDir, { recursive: true });

    const models = await this.models();
    const model = models.resolve(profile.provider, profile.modelId);
    const systemPrompt = await this.systemPrompt(profile);
    const promptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
    const trace = createAgentRunTrace(this.observability, profile, input, promptHash);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: profile.compactionEnabled },
      retry: { enabled: profile.maxRetries > 0, maxRetries: profile.maxRetries },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.workDir,
      agentDir: this.config.dataDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => undefined,
      extensionFactories: [
        { name: "model-parameters", factory: createModelParametersExtension(profile) },
        { name: "turn-limit", factory: createTurnLimitExtension(profile) },
        ...(trace ? [{ name: "langfuse", factory: trace.extension }] : []),
      ],
      systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = input.continueSession && existsSync(input.sessionDir)
      ? SessionManager.continueRecent(input.workDir, input.sessionDir)
      : SessionManager.create(input.workDir, input.sessionDir);
    const customTools = this.selectTools(profile.toolNames);
    const { session } = await createAgentSession({
      cwd: input.workDir,
      agentDir: this.config.dataDir,
      authStorage: models.authStorage,
      modelRegistry: models.registry,
      model,
      thinkingLevel: profile.thinkingLevel,
      resourceLoader,
      tools: customTools.map((tool) => tool.name),
      customTools,
      sessionManager,
      settingsManager,
    });

    return { session, trace, modelName: model.name || model.id };
  }

  private models(): Promise<OpsModelRegistry> {
    this.modelsPromise ||= OpsModelRegistry.create(this.config);
    return this.modelsPromise;
  }

  private selectTools(names: readonly string[]): ToolDefinition[] {
    const byName = new Map(this.tools.map((tool) => [tool.name, tool]));
    return names.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Agent profile references unknown tool: ${name}`);
      return tool;
    });
  }

  private async systemPrompt(profile: AgentProfile): Promise<string> {
    const base = (await readFile(profile.systemPromptFile, "utf8")).trim();
    if (!base) throw new Error(`Agent Profile ${profile.id} has an empty system prompt: ${profile.systemPromptFile}`);
    const index = await knowledgeIndex(this.config.skillsDir).catch(() => "");
    return index ? `${base}\n\n${index}` : base;
  }
}
