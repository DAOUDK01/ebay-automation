import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { logger } from "../lib/logger";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parseBody<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, msg);
  }
  return r.data;
}

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Not found"));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: err.message });
  const status = err instanceof HttpError ? err.status : err?.status ?? 500;
  if (status >= 500) logger.error(`${req.method} ${req.originalUrl}`, err);
  res.status(status).json({ error: status >= 500 && process.env.NODE_ENV === "production" ? "Server error" : err?.message ?? "Server error" });
}
