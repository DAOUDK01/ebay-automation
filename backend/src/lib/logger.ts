type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, msg: string, meta?: unknown) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const extra = meta === undefined ? "" : meta instanceof Error ? ` ${meta.stack || meta.message}` : ` ${JSON.stringify(meta)}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line + extra);
}

export const logger = {
  debug: (m: string, meta?: unknown) => process.env.DEBUG && log("debug", m, meta),
  info: (m: string, meta?: unknown) => log("info", m, meta),
  warn: (m: string, meta?: unknown) => log("warn", m, meta),
  error: (m: string, meta?: unknown) => log("error", m, meta),
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
