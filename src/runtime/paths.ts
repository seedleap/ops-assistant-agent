import { createHash } from "node:crypto";
import { join } from "node:path";

function scopedKey(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/** 原始用户 ID 只进业务记录，文件系统只使用不可穿越的哈希键。 */
export function conversationKey(userId: string, imThreadId: string): string {
  return scopedKey("conversation", userId, imThreadId);
}

export function conversationWorkDir(dataDir: string, userId: string, imThreadId: string, kind: "interactive" | "outreach"): string {
  return join(dataDir, "workspaces", conversationKey(userId, imThreadId), kind);
}
