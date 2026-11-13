import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see backend/.env.example)`);
  return v;
}

const ebayEnv = (process.env.EBAY_ENV || "production") === "sandbox" ? "sandbox" : "production";

export const env = {
  port: Number(process.env.PORT || 4100),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3100",
  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://127.0.0.1:27017/ebay-optimizer",
  mongoDbName: process.env.MONGODB_DB || "ebay-optimizer",
  get jwtSecret() {
    return required("JWT_SECRET");
  },
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  isProd: process.env.NODE_ENV === "production",
  ebay: {
    env: ebayEnv,
    clientId: process.env.EBAY_CLIENT_ID || "",
    clientSecret: process.env.EBAY_CLIENT_SECRET || "",
    ruName: process.env.EBAY_RUNAME || "",
    apiBase: ebayEnv === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
    authBase: ebayEnv === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com",
  },
  workerPollSeconds: Number(process.env.WORKER_POLL_SECONDS || 20),
};
