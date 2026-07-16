import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { createReadKnowledgeTool, knowledgeIndex } from "../integrations/knowledge/service.js";
import { createOpsDataTools } from "../integrations/loopit/data-tools.js";
import { RemoteOpsMcpClient } from "../integrations/loopit/mcp-client.js";
import type { AssistantRunInput } from "../domain/types.js";
import { createAgentRunTrace, type AgentRunTrace } from "../observability/langfuse.js";
import type { Observability } from "../observability/index.js";
import { createModelParametersExtension, createTurnLimitExtension } from "./extensions.js";
import { OpsModelRegistry } from "./models.js";
import type { AgentProfile } from "./profiles/types.js";
import { RemoteSkillStore } from "../integrations/skills/index.js";

export interface OpsSessionHandle {
  session: AgentSession;
  trace?: AgentRunTrace;
  modelName: string;
}

export class OpsSessionFactory {
  private modelsPromise?: Promise<OpsModelRegistry>;
  private readonly tools: ToolDefinition[];
  private readonly opsMcp: RemoteOpsMcpClient;
  private readonly remoteSkills: RemoteSkillStore;

  constructor(
    private readonly config: AppConfig,
    private readonly observability: Observability,
  ) {
    this.opsMcp = new RemoteOpsMcpClient(config.opsMcp);
    this.remoteSkills = new RemoteSkillStore(config.remoteSkills ?? {
      enabled: false,
      prefix: "skills",
      cacheDir: "./data/skill-cache",
      timeoutMs: 120_000,
      maxBytes: 20 * 1024 * 1024,
    });
    this.tools = [
      ...createOpsDataTools(this.opsMcp),
      createReadKnowledgeTool(config.skillsDir),
    ];
  }

  close(): Promise<void> {
    return this.opsMcp.close();
  }

  /*
   * 这里是应用接入 Pi 的唯一组合点。
   * Profile 决定模型、提示词、工具和运行限制；本类只负责把它们转换成 Pi 的标准配置。
   */
  async create(profile: AgentProfile, input: AssistantRunInput): Promise<OpsSessionHandle> {
    await mkdir(input.workDir, { recursive: true });
    await mkdir(input.sessionDir, { recursive: true });
    await this.materializeSkills(profile, input.workDir);

    const models = await this.models();
    const model = models.resolve(profile.model.provider, profile.model.modelId);
    const systemPrompt = await this.systemPrompt(profile);
    const promptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
    const trace = createAgentRunTrace(this.observability, profile, input, promptHash);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: profile.runtime.compactionEnabled },
      retry: {
        enabled: profile.runtime.maxRetries > 0,
        maxRetries: profile.runtime.maxRetries,
      },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.workDir,
      agentDir: this.config.dataDir,
      settingsManager,
      noExtensions: true,
      // Skill 文件已按 Profile 物料化到 workDir/.pi/skills，交给 Pi 按标准策略
      // 发现并注册到 system prompt；模型只在任务匹配时用 read 按需读取全文。
      noSkills: false,
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
      thinkingLevel: profile.model.thinkingLevel,
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
    const base = (await readFile(profile.prompt.file, "utf8")).trim();
    if (!base) throw new Error(`Agent Profile ${profile.id} has an empty system prompt: ${profile.prompt.file}`);
    // 系统提示和知识库目录在一轮会话内保持稳定，避免把易变信息放进缓存前缀。
    const index = await knowledgeIndex(this.config.skillsDir).catch(() => "");
    return `${base}${index ? `\n\n${index}` : ""}`;
  }

  private async materializeSkills(profile: AgentProfile, workDir: string): Promise<void> {
    const localSkills = profile.localSkills ?? [];
    const targetRoot = join(workDir, ".pi", "skills");
    for (const name of localSkills) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`invalid local skill name: ${name}`);
      }
      const source = join(this.config.skillsDir, name);
      if (!existsSync(join(source, "SKILL.md"))) {
        throw new Error(`local skill ${name} is missing SKILL.md`);
      }
      await cp(source, join(targetRoot, name), { recursive: true, force: true });
    }

    const skills = profile.skills ?? [];
    if (skills.length === 0) return;
    if (!this.config.remoteSkills?.enabled) {
      throw new Error(`profile ${profile.id} declares remote skills but REMOTE_SKILLS_ENABLED=false`);
    }
    for (const skill of skills) {
      await this.remoteSkills.materialize(skill, `${workDir}/.pi/skills/${skill.id}`);
    }
  }
}
