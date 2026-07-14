import type { RequestHandler } from "express";
import { expressjwt } from "express-jwt";
import type { AppConfig } from "../config.js";

const passthrough: RequestHandler = (_req, _res, next) => next();

export function createAuthentication(config: AppConfig): RequestHandler {
  if (config.auth.mode === "none") return passthrough;
  if (!config.auth.jwtSecret) throw new Error("JWT authentication requires a secret");

  return expressjwt({
    secret: config.auth.jwtSecret,
    algorithms: ["HS256"],
    ...(config.auth.issuer ? { issuer: config.auth.issuer } : {}),
    ...(config.auth.audience ? { audience: config.auth.audience } : {}),
  });
}
