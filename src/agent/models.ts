import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface ModelOption {
  id: string;
  provider: string;
  label: string;
  note: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gemini-3-flash-preview",
    provider: "google-vertex",
    label: "Gemini 3.0 Flash",
    note: "默认创作者对话模型",
  },
  {
    id: "gemini-3.1-flash-lite",
    provider: "google-vertex",
    label: "Gemini 3.1 Flash Lite",
    note: "轻量主动触达模型",
  },
];

const EXTRA_MODEL_COSTS: Record<string, PiModel["cost"]> = {
  "google-vertex/gemini-3.1-flash-lite": {
    input: 0.1,
    output: 0.4,
    cacheRead: 0.01,
    cacheWrite: 0,
  },
};

export class OpsModelRegistry {
  readonly authStorage: AuthStorage;
  readonly registry: ModelRegistry;

  private constructor(
    private readonly config: AppConfig,
    authStorage: AuthStorage,
    registry: ModelRegistry,
  ) {
    this.authStorage = authStorage;
    this.registry = registry;
  }

  static async create(config: AppConfig): Promise<OpsModelRegistry> {
    const authPath = join(config.dataDir, "pi-auth", "auth.json");
    await mkdir(dirname(authPath), { recursive: true });
    const authStorage = AuthStorage.create(authPath);
    const registry = ModelRegistry.create(authStorage);
    return new OpsModelRegistry(config, authStorage, registry);
  }

  resolve(provider: string, modelId: string): PiModel {
    const key = `${provider}/${modelId}`;
    if (!this.config.modelWhitelist.includes(key)) {
      throw new Error(`Model is not allowed: ${key}`);
    }

    const found = this.registry.find(provider, modelId);
    if (found) {
      return found;
    }

    if (!EXTRA_MODEL_COSTS[key]) {
      throw new Error(`Model is not configured in Pi or the local model catalog: ${key}`);
    }

    // Pi's catalog can lag behind an allowlisted preview model. Keep this
    // explicit catalog extension next to model resolution.
    const template = this.registry.find(provider, "gemini-3-flash-preview") ||
      this.registry.find(provider, "gemini-2.5-flash");
    if (!template) {
      throw new Error(`Model is not configured: ${key}`);
    }

    const option = MODEL_OPTIONS.find((item) => item.provider === provider && item.id === modelId);
    return {
      ...template,
      id: modelId,
      name: option?.label || modelId,
      ...(EXTRA_MODEL_COSTS[key] ? { cost: EXTRA_MODEL_COSTS[key] } : {}),
    };
  }
}
