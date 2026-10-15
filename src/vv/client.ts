import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_RETRIES = 2;

export function messageForStatus(status: number): string {
  if (status === 403) return "ВкусВилл заблокировал запрос. Попробуй позже.";
  if (status === 429) return "ВкусВилл сейчас занят, попробуй через минуту.";
  if (status === 401) return "ВкусВилл не пустил запрос. Попробуй позже.";
  return "ВкусВилл сейчас не отвечает, попробуй позже.";
}

export function extractSupportId(body: string): string | undefined {
  const match = /support(?:\s|-)?id[:\s#]*([A-Za-z0-9._:-]+)/i.exec(body);
  return match?.[1];
}

export class HttpFailure extends Error {
  readonly userMessage: string;

  constructor(
    readonly status: number,
    readonly supportId?: string,
  ) {
    super(`http ${status}`);
    this.name = "HttpFailure";
    this.userMessage = messageForStatus(status);
  }
}

export async function withHttpPolicy<T>(
  fn: () => Promise<T>,
  opts?: {
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (entry: { status: number; supportId?: string }) => void;
  },
): Promise<T> {
  const retries = opts?.retries ?? DEFAULT_RETRIES;
  const sleep = opts?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const http = asHttpFailure(error);
      if (!http) throw error;
      const retryable = http.status === 429 || http.status >= 500;
      if (!retryable || attempt === retries) {
        opts?.log?.({ status: http.status, supportId: http.supportId });
        throw http;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

export class McpVvClient {
  private client: Client | null = null;

  constructor(
    private readonly opts: {
      url: string;
      userAgent: string;
      sleep?: (ms: number) => Promise<void>;
      log?: (entry: { status: number; supportId?: string }) => void;
    },
  ) {}

  async listToolNames(): Promise<string[]> {
    const client = await this.ensure();
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return withHttpPolicy(
      async () => {
        const client = await this.ensure();
        const result = await client.callTool({ name, arguments: args });
        return parseToolResult(result);
      },
      { sleep: this.opts.sleep, log: this.opts.log },
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: {
        headers: {
          "User-Agent": this.opts.userAgent,
        },
      },
    });
    const client = new Client({ name: "slack-vkusvill-bot", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

function asHttpFailure(error: unknown): HttpFailure | null {
  if (error instanceof HttpFailure) return error;
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; status?: unknown; message?: unknown };
  const status = typeof record.code === "number" ? record.code : typeof record.status === "number" ? record.status : undefined;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    const body = typeof record.message === "string" ? record.message : "";
    return new HttpFailure(status, extractSupportId(body));
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return new HttpFailure(503);
  return null;
}

function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") throw new Error("empty mcp result");
  const content = (result as { content?: { text?: string }[] }).content;
  const text = content?.[0]?.text;
  if (!text) throw new Error("empty mcp result");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("mcp result is not json");
  }
  if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false) {
    throw new HttpFailure(502);
  }
  return parsed;
}
