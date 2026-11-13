import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { AUTH_COOKIE, requireAuth, setSessionCookie } from "../middleware/auth";
import { HttpError, parseBody } from "../middleware/error";
import { User } from "../models/User";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "at least 8 characters"),
  name: z.string().max(100).optional().default(""),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

const publicUser = (u: any) => ({ id: String(u._id), email: u.email, name: u.name });

router.post("/register", async (req, res) => {
  const body = parseBody(registerSchema, req.body);
  if (await User.exists({ email: body.email.toLowerCase() })) throw new HttpError(409, "Email already registered");
  const user = await User.create({ email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) });
  setSessionCookie(res, String(user._id));
  res.status(201).json({ user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const body = parseBody(loginSchema, req.body);
  const user = await User.findOne({ email: body.email.toLowerCase() });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw new HttpError(401, "Wrong email or password");
  setSessionCookie(res, String(user._id));
  res.json({ user: publicUser(user) });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) throw new HttpError(401, "Not signed in");
  res.json({ user: publicUser(user) });
});

export default router;
