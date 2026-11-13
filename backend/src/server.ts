import { createApp } from "./app";
import { env } from "./config/env";
import { connectDb } from "./db";
import { logger } from "./lib/logger";

async function main() {
  // fail fast on missing secrets
  void env.jwtSecret;
  void env.encryptionKey;
  await connectDb();
  createApp().listen(env.port, () => {
    logger.info(`API listening on http://localhost:${env.port} (eBay ${env.ebay.env})`);
  });
}

main().catch((e) => {
  logger.error("server failed to start", e);
  process.exit(1);
});
