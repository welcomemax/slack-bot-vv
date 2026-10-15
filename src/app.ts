import { App, LogLevel } from "@slack/bolt";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Actions,
  cartFallbackMessage,
  cartReadyMessage,
  discountMessage,
  moreDiscountsMessage,
  myOrderMessage,
  plainMessage,
  searchMessage,
  stripMention,
  summaryMessage,
  type SlackMessage,
} from "./blocks.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import {
  addToOrder,
  cutoffDay,
  formatDay,
  SqliteOrdersRepo,
  type DayOrder,
  type OrdersRepo,
} from "./orders.ts";
import { HttpFailure, McpVvClient } from "./vv/client.ts";
import { TtlCache, VvCatalog, type Product } from "./vv/catalog.ts";

const REFUSAL = "Здесь я не работаю.";

interface SlackUser {
  id: string;
  username?: string;
  name?: string;
}

interface SlackClient {
  chat: {
    postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
    postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    update: (args: Record<string, unknown>) => Promise<unknown>;
  };
  reactions: {
    add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
  };
}

export function createApp(deps: { config: AppConfig; repo: OrdersRepo; catalog: VvCatalog }) {
  const { config, repo, catalog } = deps;
  const shown = new Map<string, Product>();
  const lists = new Map<string, Product[]>();
  const labels = new Map<string, string>();
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  app.command("/vv", async ({ ack, command, client }) => {
    await ack();
    const channel = command.channel_id;
    const userId = command.user_id;
    const slack = client as unknown as SlackClient;
    if (!config.allowedChannels.has(channel)) {
      await say(slack, channel, userId, REFUSAL);
      return;
    }
    rememberUser(labels, { id: userId, username: command.user_name });
    const day = today(config);
    const existing = repo.get(channel, day);
    if (existing?.status === "closed") {
      await say(slack, channel, userId, "Заказ на сегодня уже оформлен.");
      return;
    }
    let rootTs = existing?.rootTs ?? null;
    try {
      if (!existing) {
        const placeholder = await slack.chat.postMessage({
          channel,
          text: "вкусвилл :cherries: Собираю акции на готовую еду…",
        });
        rootTs = placeholder.ts ?? null;
        if (!rootTs) return;
        repo.open({ channelId: channel, day, organizerId: userId, rootTs });
      }
      const discounts = await catalog.readyFoodDiscounts();
      rememberProducts(shown, discounts);
      lists.set(listKey(channel, day), discounts);
      const message = discountMessage(discounts, { top: config.topDiscounts });
      if (!rootTs) return;
      await slack.chat.update({ channel, ts: rootTs, text: message.text, blocks: message.blocks });
      if (existing) await say(slack, channel, userId, "Список акций обновил.").catch(() => undefined);
    } catch (error) {
      const text = failureText("discount", error);
      if (rootTs && !existing) {
        await slack.chat.update({ channel, ts: rootTs, text, blocks: plainMessage(text).blocks }).catch(() => undefined);
      } else {
        await say(slack, channel, userId, text);
      }
    }
  });

  app.action(Actions.want, async ({ ack, body, action, client }) => {
    await ack();
    await withChannel(config, client as unknown as SlackClient, body, async ({ channel, user }) => {
      const xmlId = buttonValue(action);
      const day = today(config);
      const order = repo.get(channel, day);
      if (!order) {
        await say(client as unknown as SlackClient, channel, user.id, "Сегодня заказ ещё не открыт. Нужна команда /vv.");
        return;
      }
      if (order.status !== "open") {
        await say(client as unknown as SlackClient, channel, user.id, "Заказ уже оформлен.");
        return;
      }
      const product = xmlId ? shown.get(xmlId) : undefined;
      if (!product) {
        await say(client as unknown as SlackClient, channel, user.id, "Не нашёл это блюдо. Напиши боту название ещё раз.");
        return;
      }
      rememberUser(labels, user);
      const result = addToOrder(repo, channel, day, {
        userId: user.id,
        xmlId: product.xmlId,
        name: product.name,
        price: product.priceCurrent,
      });
      const slack = client as unknown as SlackClient;
      if (!result.ok) {
        await say(slack, channel, user.id, result.reason === "qty-limit" ? qtyLimit() : "Заказ уже оформлен.");
        return;
      }
      await refreshSummary(slack, repo, labels, channel, day);
      await say(slack, channel, user.id, "Записал.");
    });
  });

  app.action(Actions.more, async ({ ack, body, client }) => {
    await ack();
    await withChannel(config, client as unknown as SlackClient, body, async ({ channel, user }) => {
      const all = lists.get(listKey(channel, today(config)));
      if (!all) {
        await say(client as unknown as SlackClient, channel, user.id, "Список акций уже не в памяти. Вызови /vv ещё раз.");
        return;
      }
      await say(client as unknown as SlackClient, channel, user.id, moreDiscountsMessage(all.slice(config.topDiscounts)));
    });
  });

  app.action(Actions.myOrder, async ({ ack, body, client }) => {
    await ack();
    await withChannel(config, client as unknown as SlackClient, body, async ({ channel, user }) => {
      rememberUser(labels, user);
      const items = (repo.get(channel, today(config))?.items ?? []).filter((item) => item.userId === user.id);
      await say(client as unknown as SlackClient, channel, user.id, myOrderMessage(items));
    });
  });

  app.action(Actions.inc, async ({ ack, body, action, client, respond }) => {
    await ack();
    await changeOwnLine(config, repo, labels, client as unknown as SlackClient, body, buttonValue(action), respond, "inc");
  });

  app.action(Actions.remove, async ({ ack, body, action, client, respond }) => {
    await ack();
    await changeOwnLine(config, repo, labels, client as unknown as SlackClient, body, buttonValue(action), respond, "remove");
  });

  app.action(Actions.cart, async ({ ack, body, client }) => {
    await ack();
    await withChannel(config, client as unknown as SlackClient, body, async ({ channel, user }) => {
      const slack = client as unknown as SlackClient;
      const day = today(config);
      const order = repo.get(channel, day);
      if (!order || order.status !== "open") {
        await say(slack, channel, user.id, order ? "Заказ уже оформлен." : "Сегодня заказ ещё не открыт. Нужна команда /vv.");
        return;
      }
      if (user.id !== order.organizerId) {
        await say(slack, channel, user.id, "Собрать корзину может только тот, кто сегодня вызвал /vv.");
        return;
      }
      if (order.items.length === 0) {
        await say(slack, channel, user.id, "Заказ пустой.");
        return;
      }
      const lines = cartLines(order, shown);
      try {
        const links = await catalog.createCartLinks(lines);
        await postInThread(slack, channel, order.rootTs, cartReadyMessage(links));
      } catch (error) {
        failureText("cart", error);
        const known = order.items.flatMap((item) => {
          const product = shown.get(item.xmlId);
          return product ? [product] : [];
        });
        await postInThread(slack, channel, order.rootTs, cartFallbackMessage(known, order.items));
      }
    });
  });

  app.action(Actions.close, async ({ ack, body, client }) => {
    await ack();
    await withChannel(config, client as unknown as SlackClient, body, async ({ channel, user }) => {
      const slack = client as unknown as SlackClient;
      const day = today(config);
      const order = repo.get(channel, day);
      if (!order) {
        await say(slack, channel, user.id, "Сегодня заказ ещё не открыт. Нужна команда /vv.");
        return;
      }
      if (user.id !== order.organizerId) {
        await say(slack, channel, user.id, "Отметить заказ может только тот, кто сегодня вызвал /vv.");
        return;
      }
      if (order.status === "closed") {
        await say(slack, channel, user.id, "Заказ уже оформлен.");
        return;
      }
      repo.close(channel, day);
      if (order.rootTs) {
        await slack.reactions
          .add({ channel, timestamp: order.rootTs, name: "white_check_mark" })
          .catch((error: unknown) => {
            if (!isAlreadyReacted(error)) logFailure("reaction", error);
          });
      }
      await postInThread(slack, channel, order.rootTs, plainMessage("Заказ оформлен. Новое уже не записываю."));
    });
  });

  app.event("app_mention", async ({ event, client }) => {
    const channel = event.channel;
    const userId = event.user;
    const slack = client as unknown as SlackClient;
    if (!userId) return;
    if (!config.allowedChannels.has(channel)) {
      await say(slack, channel, userId, REFUSAL);
      return;
    }
    const query = stripMention(event.text ?? "");
    const thread = event.thread_ts ?? event.ts;
    if (!query) {
      await postInThread(slack, channel, thread, plainMessage("Напиши, что искать. Например: карбонара"));
      return;
    }
    try {
      const found = await catalog.searchReadyFood(query);
      rememberProducts(shown, found);
      await postInThread(slack, channel, thread, searchMessage(found));
    } catch (error) {
      await postInThread(slack, channel, thread, plainMessage(failureText("search", error)));
    }
  });

  return app;
}

async function changeOwnLine(
  config: AppConfig,
  repo: OrdersRepo,
  labels: Map<string, string>,
  client: SlackClient,
  body: { user?: SlackUser; channel?: { id?: string } },
  xmlId: string | undefined,
  respond: (message: Record<string, unknown>) => Promise<unknown>,
  mode: "inc" | "remove",
): Promise<void> {
  await withChannel(config, client, body, async ({ channel, user }) => {
    const day = today(config);
    const order = repo.get(channel, day);
    if (!order || order.status !== "open" || !xmlId) {
      await say(client, channel, user.id, order?.status === "closed" ? "Заказ уже оформлен." : "Сегодня заказ ещё не открыт. Нужна команда /vv.");
      return;
    }
    const current = order.items.find((item) => item.userId === user.id && item.xmlId === xmlId);
    if (!current) {
      await say(client, channel, user.id, "Этой позиции у тебя нет.");
      return;
    }
    if (mode === "remove") {
      repo.remove(channel, day, user.id, xmlId);
    } else {
      const result = addToOrder(repo, channel, day, current);
      if (!result.ok) {
        await say(client, channel, user.id, qtyLimit());
        return;
      }
    }
    rememberUser(labels, user);
    await refreshSummary(client, repo, labels, channel, day);
    const items = (repo.get(channel, day)?.items ?? []).filter((item) => item.userId === user.id);
    const message = myOrderMessage(items);
    await respond({ replace_original: true, text: message.text, blocks: message.blocks });
  });
}

async function withChannel(
  config: AppConfig,
  client: SlackClient,
  body: { user?: SlackUser; channel?: { id?: string } },
  run: (ctx: { channel: string; user: SlackUser }) => Promise<void>,
): Promise<void> {
  const channel = body.channel?.id;
  const user = body.user;
  if (!channel || !user?.id) return;
  if (!config.allowedChannels.has(channel)) {
    await say(client, channel, user.id, REFUSAL);
    return;
  }
  await run({ channel, user });
}

async function refreshSummary(
  client: SlackClient,
  repo: OrdersRepo,
  labels: Map<string, string>,
  channel: string,
  day: string,
): Promise<void> {
  const order = repo.get(channel, day);
  if (!order?.rootTs) return;
  const message = summaryMessage(order.items, labels);
  if (order.summaryTs) {
    await client.chat.update({ channel, ts: order.summaryTs, text: message.text, blocks: message.blocks });
    return;
  }
  const posted = await client.chat.postMessage({
    channel,
    thread_ts: order.rootTs,
    text: message.text,
    blocks: message.blocks,
  });
  if (posted.ts) repo.setSummaryTs(channel, day, posted.ts);
}

async function postInThread(client: SlackClient, channel: string, threadTs: string | null, message: SlackMessage): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs ?? undefined,
    text: message.text,
    blocks: message.blocks,
  });
}

async function say(client: SlackClient, channel: string, user: string, message: SlackMessage | string): Promise<void> {
  const payload = typeof message === "string" ? plainMessage(message) : message;
  await client.chat.postEphemeral({ channel, user, text: payload.text, blocks: payload.blocks });
}

function cartLines(order: DayOrder, shown: Map<string, Product>): { xmlIdNum: number; qty: number }[] {
  const totals = new Map<number, number>();
  for (const item of order.items) {
    const xmlIdNum = shown.get(item.xmlId)?.xmlIdNum ?? Number(item.xmlId);
    if (!Number.isInteger(xmlIdNum) || xmlIdNum < 1) continue;
    totals.set(xmlIdNum, (totals.get(xmlIdNum) ?? 0) + item.qty);
  }
  return [...totals].map(([xmlIdNum, qty]) => ({ xmlIdNum, qty }));
}

function rememberProducts(index: Map<string, Product>, products: Product[]): void {
  for (const product of products) index.set(product.xmlId, product);
}

function rememberUser(labels: Map<string, string>, user: SlackUser): void {
  const label = user.username || user.name;
  if (label) labels.set(user.id, label);
}

function buttonValue(action: unknown): string | undefined {
  if (!action || typeof action !== "object" || !("value" in action)) return undefined;
  const value = (action as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function today(config: AppConfig): string {
  return formatDay(new Date(), config.timeZone);
}

function listKey(channel: string, day: string): string {
  return `${channel}:${day}`;
}

function qtyLimit(): string {
  return "Больше 40 штук одной позиции не записываю.";
}

function failureText(scope: string, error: unknown): string {
  logFailure(scope, error);
  if (error instanceof HttpFailure) return error.userMessage;
  return "ВкусВилл сейчас не отвечает, попробуй позже.";
}

function logFailure(scope: string, error: unknown): void {
  if (error instanceof HttpFailure) {
    console.error(`[vv] ${scope} status=${error.status} supportId=${error.supportId ?? "-"}`);
    return;
  }
  const name = error instanceof Error ? error.name : "unknown";
  console.error(`[bot] ${scope} error=${name}`);
}

function isAlreadyReacted(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = (error as { data?: { error?: string } }).data;
  return data?.error === "already_reacted";
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const repo = new SqliteOrdersRepo(config.dbPath);
  const purge = () => {
    const removed = repo.deleteOlderThan(cutoffDay(new Date(), config.timeZone, config.retentionDays));
    if (removed > 0) console.error(`[bot] purged orders=${removed}`);
  };
  purge();
  const timer = setInterval(purge, 24 * 60 * 60 * 1000);
  timer.unref();
  const catalog = new VvCatalog(
    new McpVvClient({
      url: config.vvMcpUrl,
      userAgent: config.vvUserAgent,
    }),
    new TtlCache(),
    { discountTtlMs: config.discountCacheMs, searchTtlMs: config.searchCacheMs },
  );
  const app = createApp({ config, repo, catalog });
  await app.start();
  console.error("[bot] socket mode started");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message && !/xox|xapp|token/i.test(message)) console.error(`[bot] start: ${message}`);
    else console.error("[bot] start failed");
    process.exitCode = 1;
  });
}
