import mongoose from "mongoose";
import { env } from "./config/env";
import { logger } from "./lib/logger";

export async function connectDb(): Promise<void> {
  mongoose.set("strictQuery", true);
  // dbName keeps data in a named database even when the URI has no path (e.g. Railway's MONGO_URL)
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  logger.info(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}
