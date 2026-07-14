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
import type { AgentProfile } from "./profiles.js";

const DEFAULT_SYSTEM_PROMPT = `你是 Loopit 的创作小助手，帮创作者了解自己的作品、读懂玩家、把作品做得更好。
温暖、简洁、会打气，说“你的作品”。只用工具查到的真实数据与后台知识库说话，不编数字、不杜撰活动。
聊创作技巧或 Loopit 能力时调 read_knowledge('creator_guide')，聊活动时调 read_knowledge('ops_activities')。
做主动触达只写一条简短 IM；不值得打扰就回 NO_OUTREACH: <原因>。`;

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
    const trace = createAgentRunTrace(this.observability, profile, input);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: profile.compactionEnabled },
      retry: { enabled: true, maxRetries: 2 },
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
      systemPrompt: await this.systemPrompt(),
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

  private async systemPrompt(): Promise<string> {
    const base = await readFile(this.config.systemPromptFile, "utf8")
      .then((value) => value.trim() || DEFAULT_SYSTEM_PROMPT)
      .catch(() => DEFAULT_SYSTEM_PROMPT);
    const index = await knowledgeIndex(this.config.skillsDir).catch(() => "");
    return index ? `${base}\n\n${index}` : base;
  }
}
