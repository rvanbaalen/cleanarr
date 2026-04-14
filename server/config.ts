import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  RADARR_URL: z.string().url(),
  RADARR_API_KEY: z.string().min(1),
  SONARR_URL: z.string().url(),
  SONARR_API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(8),
  DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SEASON_DEBOUNCE_MS: z.coerce.number().default(10_000),
  EVENTS_RETENTION_DAYS: z.coerce.number().default(30),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  DATA_DIR: z.string().default("/app/data"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Invalid configuration:\n" +
        result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
    process.exit(1);
  }
  return result.data;
}
