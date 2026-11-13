import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Store, type StoreDocument } from "../models/Store";
import { HttpError } from "./error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const AUTH_COOKIE = "eo_token";

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: "7d" });
}

export function setSessionCookie(res: Response, userId: string) {
  res.cookie(AUTH_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: 7 * 24 * 3600_000,
    path: "/",
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE] || req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) return next(new HttpError(401, "Not signed in"));
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, "Session expired - please sign in again"));
  }
}

/** Loads :storeId (or :id) and verifies it belongs to the signed-in user. */
export async function loadStore(req: Request): Promise<StoreDocument> {
  const id = String(req.params.storeId ?? req.params.id ?? "");
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new HttpError(404, "Store not found");
  const store = (await Store.findOne({ _id: id, userId: req.userId })) as StoreDocument | null;
  if (!store) throw new HttpError(404, "Store not found");
  return store;
}
