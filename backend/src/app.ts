import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env";
import { requireAuth } from "./middleware/auth";
import { errorHandler, notFound } from "./middleware/error";
import authRoutes from "./routes/auth";
import { batchesRouter, proposalsRouter } from "./routes/batches";
import ebayRoutes from "./routes/ebay";
import listingRoutes from "./routes/listings";
import storeRoutes from "./routes/stores";
import { mountModules } from "./modules";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.frontendUrl, credentials: true }));
  app.use(express.json({ limit: "6mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, db: mongoose.connection.readyState === 1 ? "up" : "down", ebayEnv: env.ebay.env });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/ebay", ebayRoutes);
  app.use("/api/stores/:storeId/listings", requireAuth, listingRoutes);
  app.use("/api/stores/:storeId/batches", requireAuth, batchesRouter);
  app.use("/api/stores/:storeId/proposals", requireAuth, proposalsRouter);
  mountModules(app); // orders, returns, messages, ... (src/modules/*)
  app.use("/api/stores", requireAuth, storeRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
