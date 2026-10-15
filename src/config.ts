export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  vvMcpUrl: string;
  vvUserAgent: string;
  allowedChannels: ReadonlySet<string>;
  timeZone: string;
  discountCacheMs: number;
  searchCacheMs: number;
  topDiscounts: number;
  dbPath: string;
  retentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const allowed = (env.ALLOWED_CHANNELS ?? "")
    .split(",")
    .map((channel) => channel.trim())
    .filter((channel) => channel.length > 0);
  if (allowed.length === 0) throw new Error("ALLOWED_CHANNELS is empty");
  return {
    slackBotToken: required(env, "SLACK_BOT_TOKEN"),
    slackAppToken: required(env, "SLACK_APP_TOKEN"),
    vvMcpUrl: env.VV_MCP_URL?.trim() || "https://mcp.vkusvill.ru/mcp",
    vvUserAgent: env.VV_USER_AGENT?.trim() || "slack-vkusvill-bot/1.0 (Node 24; group food order)",
    allowedChannels: new Set(allowed),
    timeZone: env.TZ?.trim() || "Europe/Moscow",
    discountCacheMs: minutes(env.DISCOUNT_CACHE_MIN, 30),
    searchCacheMs: minutes(env.SEARCH_CACHE_MIN, 10),
    topDiscounts: positive(env.TOP_DISCOUNTS, 12),
    dbPath: env.DB_PATH?.trim() || "data/orders.db",
    retentionDays: positive(env.ORDER_RETENTION_DAYS, 7),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

function minutes(value: string | undefined, fallback: number): number {
  return positive(value, fallback) * 60_000;
}

function positive(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid number: ${value}`);
  return parsed;
}
