import type { OrderItem } from "./orders.ts";
import type { Product } from "./vv/catalog.ts";

export const MAX_BLOCKS = 50;
export const MAX_BLOCK_TEXT = 3000;
const CONTEXT_TEXT_MAX = 75;
const TOP_SEARCH = 3;

export const Actions = {
  want: "want",
  more: "more",
  myOrder: "my_order",
  remove: "remove_item",
  inc: "inc_item",
  cart: "build_cart",
  close: "close_order",
} as const;

type Mrkdwn = { type: "mrkdwn"; text: string };
type Button = {
  type: "button";
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
  text: { type: "plain_text"; text: string; emoji: true };
};

export type SlackBlock =
  | { type: "section"; block_id?: string; text: Mrkdwn; accessory?: Button }
  | { type: "context"; block_id?: string; elements: Mrkdwn[] }
  | { type: "actions"; block_id?: string; elements: Button[] };

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

export function discountMessage(products: Product[], opts: { top: number }): SlackMessage {
  const top = products.slice(0, opts.top);
  const blocks: SlackBlock[] = [
    section("вкусвилл :cherries:"),
    context("Цены общие, в приложении может быть дешевле."),
  ];
  if (top.length === 0) {
    blocks.push(section("Сегодня акций на готовую еду нет. Напиши боту название — поищу."));
  } else {
    for (const product of top) blocks.push(dishSection(product), priceContext(product));
  }
  if (products.length > top.length) {
    blocks.push(actions([button("Ещё", Actions.more, "more")]));
  }
  blocks.push(orderActions());
  const text =
    top.length === 0
      ? "вкусвилл :cherries: Сегодня акций на готовую еду нет. Цены общие, в приложении может быть дешевле."
      : `вкусвилл :cherries: Акции на готовую еду: ${top.map((product) => product.name).join(", ")}. Цены общие, в приложении может быть дешевле.`;
  return finish(text, blocks);
}

export function moreDiscountsMessage(products: Product[]): SlackMessage {
  const blocks: SlackBlock[] = [];
  for (const product of products) {
    if (blocks.length + 2 > MAX_BLOCKS - 1) break;
    blocks.push(dishSection(product), priceContext(product));
  }
  if (blocks.length === 0) blocks.push(section("Больше акций нет."));
  return finish("Ещё акции на готовую еду", blocks);
}

export function searchMessage(products: Product[]): SlackMessage {
  const shown = products.slice(0, TOP_SEARCH);
  if (shown.length === 0) {
    return finish("Ничего не нашёл среди готовой еды.", [section("Ничего не нашёл среди готовой еды.")]);
  }
  const blocks: SlackBlock[] = [
    section("Нашёл в готовой еде:"),
    context("Цены общие, в приложении может быть дешевле."),
  ];
  for (const product of shown) blocks.push(dishSection(product), priceContext(product));
  return finish(`Нашёл: ${shown.map((product) => product.name).join(", ")}`, blocks);
}

export function summaryMessage(items: OrderItem[], labels: Map<string, string>): SlackMessage {
  if (items.length === 0) {
    return finish("Пока пусто.", [section("Пока пусто. Нажми «Хочу» у блюда или напиши боту название.")]);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.userId)) continue;
    seen.add(item.userId);
    const label = escapeMrkdwn(labels.get(item.userId) ?? item.userId);
    const own = items.filter((line) => line.userId === item.userId);
    const parts = own.map(
      (line) => `${escapeMrkdwn(line.name)} × ${line.qty} · ${line.price * line.qty} ₽`,
    );
    lines.push(`${label} — ${parts.join(", ")}`);
  }
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const body = [...lines, "", `Итого: ${total} ₽`].join("\n");
  return finish(`Сейчас в заказе. Итого ${total} ₽`, [section(clamp(body, MAX_BLOCK_TEXT))]);
}

export function myOrderMessage(items: OrderItem[]): SlackMessage {
  if (items.length === 0) {
    return finish("В заказе тебя пока нет.", [section("В заказе тебя пока нет.")]);
  }
  const blocks: SlackBlock[] = [];
  for (const item of items) {
    if (blocks.length + 2 > MAX_BLOCKS) break;
    blocks.push(
      section(`${escapeMrkdwn(item.name)} × ${item.qty} · ${item.price * item.qty} ₽`),
      actions([
        button("Убрать", Actions.remove, item.xmlId),
        button("+1", Actions.inc, item.xmlId),
      ]),
    );
  }
  return finish("Мой заказ", blocks);
}

export function cartReadyMessage(links: string[]): SlackMessage {
  const lines = links.map((link, index) => `<${link}|Корзина ${index + 1}>`);
  const text = `Корзина готова, проверь цены и наличие и оформи сам.\n${lines.join("\n")}`;
  return finish("Корзина готова, проверь цены и наличие и оформи сам.", [section(text)]);
}

export function cartFallbackMessage(products: Product[], items: OrderItem[]): SlackMessage {
  const byXml = new Map(products.map((product) => [product.xmlId, product]));
  const grouped = new Map<string, { name: string; qty: number; url: string | null }>();
  for (const item of items) {
    const previous = grouped.get(item.xmlId);
    if (previous) previous.qty += item.qty;
    else grouped.set(item.xmlId, { name: item.name, qty: item.qty, url: byXml.get(item.xmlId)?.url ?? null });
  }
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const lines = [...grouped.values()].map((line) => {
    const name = escapeMrkdwn(line.name);
    const label = line.url ? `<${line.url}|${name.replaceAll("|", "¦")}>` : name;
    return `• ${label} × ${line.qty}`;
  });
  const text = clamp(
    `Не получилось собрать корзину. Итого ${total} ₽.\n${lines.join("\n")}\nПроверь цены и оформи сам.`,
    MAX_BLOCK_TEXT,
  );
  return finish(`Не получилось собрать корзину. Итого ${total} ₽`, [section(text)]);
}

export function plainMessage(text: string): SlackMessage {
  return finish(text, [section(text)]);
}

function dishSection(product: Product): SlackBlock {
  const name = escapeMrkdwn(product.name).replaceAll("|", "¦");
  const text = product.url ? `<${product.url}|${name}>` : name;
  return {
    type: "section",
    text: { type: "mrkdwn", text: clamp(text, MAX_BLOCK_TEXT) },
    accessory: button("Хочу", Actions.want, product.xmlId),
  };
}

function priceContext(product: Product): SlackBlock {
  const price =
    product.priceOld != null && product.priceOld !== product.priceCurrent
      ? `~${product.priceOld}~ ${product.priceCurrent} ₽`
      : `${product.priceCurrent} ₽`;
  const parts = [price];
  if (product.discountPercent != null) parts.push(`−${Math.round(product.discountPercent)}%`);
  if (product.discountInfo) parts.push(escapeMrkdwn(product.discountInfo));
  return context(clamp(parts.join(" · "), CONTEXT_TEXT_MAX));
}

function orderActions(): SlackBlock {
  return actions([
    button("Мой заказ", Actions.myOrder, "my"),
    button("Собрать корзину", Actions.cart, "cart"),
    button("Заказ оформлен", Actions.close, "close"),
  ]);
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: clamp(text, MAX_BLOCK_TEXT) } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: clamp(text, CONTEXT_TEXT_MAX) }] };
}

function actions(elements: Button[]): SlackBlock {
  return { type: "actions", elements };
}

function button(label: string, actionId: string, value: string): Button {
  return {
    type: "button",
    action_id: actionId,
    value: value.slice(0, 2000),
    text: { type: "plain_text", text: label.slice(0, 75), emoji: true },
  };
}

function finish(text: string, blocks: SlackBlock[]): SlackMessage {
  return {
    text: clamp(escapeFallback(text), MAX_BLOCK_TEXT),
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
}

function escapeFallback(text: string): string {
  return text.replaceAll("<!", "&lt;!").replaceAll("<@", "&lt;@");
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
