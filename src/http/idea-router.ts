import express from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { IdeaWorkflow } from "../ideas/workflow.js";
import type { JsonStore } from "../infrastructure/persistence/json-store.js";
import type { IdeaWorkflowRecord } from "../domain/types.js";

export class IdeaAuthorizationError extends Error {}

const workflowSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  projectId: z.string().trim().min(1).max(128).optional(),
  theme: z.string().trim().min(1).max(2_000),
  audience: z.string().trim().min(1).max(1_000),
  emotion: z.string().trim().min(1).max(1_000),
  duration: z.string().trim().min(1).max(200).default("30-60 秒"),
  notes: z.string().trim().max(4_000).optional(),
  forbidden: z.string().trim().max(2_000).optional(),
  count: z.number().int().min(1).max(8).default(4),
}).strict();
function requestSubject(req: express.Request): string | undefined {
  const auth = (req as express.Request & { auth?: { sub?: unknown } }).auth;
  return typeof auth?.sub === "string" && auth.sub.trim() ? auth.sub : undefined;
}

function publicWorkflow(record: IdeaWorkflowRecord) {
  const {
    idempotencyKey: _idempotencyKey,
    inputHash: _inputHash,
    checkpoints: _checkpoints,
    cancelRequested: _cancelRequested,
    metadata: _metadata,
    attempt: _attempt,
    ...response
  } = record;
  return response;
}

export function createIdeaRouter(input: {
  config: AppConfig;
  store: JsonStore;
  workflow?: IdeaWorkflow;
}): express.Router {
  const { config, store, workflow } = input;
  const router = express.Router();
  const assertUser = (req: express.Request, userId: string): void => {
    if (config.auth.mode !== "jwt") return;
    if (requestSubject(req) !== userId) throw new IdeaAuthorizationError("authenticated user does not match userId");
  };

  router.post("/generate", async (req, res, next) => {
    try {
      if (!workflow) {
        res.status(503).json({ error: "idea workflow is unavailable" });
        return;
      }
      const request = workflowSchema.parse(req.body);
      assertUser(req, request.userId);
      const idempotencyKey = req.get("Idempotency-Key") || "";
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        res.status(400).json({
          error: "Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon or hyphen",
        });
        return;
      }
      const result = await workflow.start(request, idempotencyKey);
      const terminal = ["completed", "completed_with_errors", "failed", "canceled"].includes(result.workflow.status);
      res.status(result.created || !terminal ? 202 : 200).json({
        workflow: publicWorkflow(result.workflow),
        idempotentReplay: !result.created,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res) => {
    const record = store.getIdeaWorkflow(req.params.id);
    if (!record) {
      res.status(404).json({ error: "idea workflow not found" });
      return;
    }
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    try {
      assertUser(req, userId);
    } catch {
      res.status(404).json({ error: "idea workflow not found" });
      return;
    }
    if (!userId || record.userId !== userId) {
      res.status(404).json({ error: "idea workflow not found" });
      return;
    }
    res.json({ workflow: publicWorkflow(record) });
  });

  return router;
}
