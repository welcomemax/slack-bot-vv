import { DatabaseSync } from "node:sqlite";

const MAX_LINE_QTY = 40;

export interface OrderItem {
  userId: string;
  xmlId: string;
  name: string;
  price: number;
  qty: number;
}

export interface DayOrder {
  channelId: string;
  day: string;
  organizerId: string;
  rootTs: string | null;
  summaryTs: string | null;
  status: "open" | "closed";
  items: OrderItem[];
}

export interface OrdersRepo {
  get(channelId: string, day: string): DayOrder | null;
  open(input: { channelId: string; day: string; organizerId: string; rootTs: string }): DayOrder;
  setSummaryTs(channelId: string, day: string, ts: string): void;
  add(channelId: string, day: string, item: Omit<OrderItem, "qty"> & { qty?: number }): DayOrder;
  remove(channelId: string, day: string, userId: string, xmlId: string): DayOrder;
  close(channelId: string, day: string): DayOrder;
  deleteOlderThan(day: string): number;
}

export type AddResult = { ok: true; order: DayOrder } | { ok: false; reason: "closed" | "no-order" | "qty-limit" };

export function addToOrder(
  repo: OrdersRepo,
  channelId: string,
  day: string,
  item: Omit<OrderItem, "qty"> & { qty?: number },
): AddResult {
  const order = repo.get(channelId, day);
  if (!order) return { ok: false, reason: "no-order" };
  if (order.status !== "open") return { ok: false, reason: "closed" };
  const existing = order.items.find((line) => line.userId === item.userId && line.xmlId === item.xmlId);
  const nextQty = (existing?.qty ?? 0) + (item.qty ?? 1);
  if (nextQty > MAX_LINE_QTY) return { ok: false, reason: "qty-limit" };
  return { ok: true, order: repo.add(channelId, day, item) };
}

export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function cutoffDay(now: Date, timeZone: string, days: number): string {
  const [year, month, day] = formatDay(now, timeZone).split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() - days);
  return utc.toISOString().slice(0, 10);
}

interface OrderRecord {
  channelId: string;
  day: string;
  organizerId: string;
  rootTs: string | null;
  summaryTs: string | null;
  status: "open" | "closed";
  items: OrderItem[];
}

export class MemoryOrdersRepo implements OrdersRepo {
  private readonly orders = new Map<string, OrderRecord>();

  get(channelId: string, day: string): DayOrder | null {
    const order = this.orders.get(key(channelId, day));
    return order ? clone(order) : null;
  }

  open(input: { channelId: string; day: string; organizerId: string; rootTs: string }): DayOrder {
    const id = key(input.channelId, input.day);
    const existing = this.orders.get(id);
    if (existing) return clone(existing);
    const order: OrderRecord = {
      channelId: input.channelId,
      day: input.day,
      organizerId: input.organizerId,
      rootTs: input.rootTs,
      summaryTs: null,
      status: "open",
      items: [],
    };
    this.orders.set(id, order);
    return clone(order);
  }

  setSummaryTs(channelId: string, day: string, ts: string): void {
    const order = this.orders.get(key(channelId, day));
    if (order) order.summaryTs = ts;
  }

  add(channelId: string, day: string, item: Omit<OrderItem, "qty"> & { qty?: number }): DayOrder {
    const order = this.require(channelId, day);
    const qty = item.qty ?? 1;
    const existing = order.items.find((line) => line.userId === item.userId && line.xmlId === item.xmlId);
    if (existing) {
      existing.qty += qty;
      existing.name = item.name;
      existing.price = item.price;
    } else {
      order.items.push({ userId: item.userId, xmlId: item.xmlId, name: item.name, price: item.price, qty });
    }
    return clone(order);
  }

  remove(channelId: string, day: string, userId: string, xmlId: string): DayOrder {
    const order = this.require(channelId, day);
    order.items = order.items.filter((line) => !(line.userId === userId && line.xmlId === xmlId));
    return clone(order);
  }

  close(channelId: string, day: string): DayOrder {
    const order = this.require(channelId, day);
    order.status = "closed";
    return clone(order);
  }

  deleteOlderThan(day: string): number {
    let removed = 0;
    for (const [id, order] of this.orders) {
      if (order.day < day) {
        this.orders.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private require(channelId: string, day: string): OrderRecord {
    const order = this.orders.get(key(channelId, day));
    if (!order) throw new Error("order missing");
    return order;
  }
}

export class SqliteOrdersRepo implements OrdersRepo {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        channel_id TEXT NOT NULL,
        day TEXT NOT NULL,
        organizer_id TEXT NOT NULL,
        root_ts TEXT,
        summary_ts TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY (channel_id, day)
      );
      CREATE TABLE IF NOT EXISTS items (
        channel_id TEXT NOT NULL,
        day TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xml_id TEXT NOT NULL,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        PRIMARY KEY (channel_id, day, user_id, xml_id)
      );
    `);
  }

  get(channelId: string, day: string): DayOrder | null {
    const row = this.db
      .prepare(
        `SELECT channel_id, day, organizer_id, root_ts, summary_ts, status
         FROM orders WHERE channel_id = ? AND day = ?`,
      )
      .get(channelId, day) as OrderRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  open(input: { channelId: string; day: string; organizerId: string; rootTs: string }): DayOrder {
    this.db
      .prepare(
        `INSERT INTO orders (channel_id, day, organizer_id, root_ts, summary_ts, status)
         VALUES (?, ?, ?, ?, NULL, 'open')
         ON CONFLICT(channel_id, day) DO NOTHING`,
      )
      .run(input.channelId, input.day, input.organizerId, input.rootTs);
    const order = this.get(input.channelId, input.day);
    if (!order) throw new Error("order missing");
    return order;
  }

  setSummaryTs(channelId: string, day: string, ts: string): void {
    this.db.prepare(`UPDATE orders SET summary_ts = ? WHERE channel_id = ? AND day = ?`).run(ts, channelId, day);
  }

  add(channelId: string, day: string, item: Omit<OrderItem, "qty"> & { qty?: number }): DayOrder {
    this.db
      .prepare(
        `INSERT INTO items (channel_id, day, user_id, xml_id, name, price, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, day, user_id, xml_id) DO UPDATE SET
           qty = qty + excluded.qty,
           name = excluded.name,
           price = excluded.price`,
      )
      .run(channelId, day, item.userId, item.xmlId, item.name, item.price, item.qty ?? 1);
    const order = this.get(channelId, day);
    if (!order) throw new Error("order missing");
    return order;
  }

  remove(channelId: string, day: string, userId: string, xmlId: string): DayOrder {
    this.db
      .prepare(`DELETE FROM items WHERE channel_id = ? AND day = ? AND user_id = ? AND xml_id = ?`)
      .run(channelId, day, userId, xmlId);
    const order = this.get(channelId, day);
    if (!order) throw new Error("order missing");
    return order;
  }

  close(channelId: string, day: string): DayOrder {
    this.db.prepare(`UPDATE orders SET status = 'closed' WHERE channel_id = ? AND day = ?`).run(channelId, day);
    const order = this.get(channelId, day);
    if (!order) throw new Error("order missing");
    return order;
  }

  deleteOlderThan(day: string): number {
    this.db.prepare(`DELETE FROM items WHERE day < ?`).run(day);
    const result = this.db.prepare(`DELETE FROM orders WHERE day < ?`).run(day);
    return Number(result.changes);
  }

  private hydrate(row: OrderRow): DayOrder {
    const items = this.db
      .prepare(
        `SELECT user_id, xml_id, name, price, qty
         FROM items WHERE channel_id = ? AND day = ?
         ORDER BY rowid`,
      )
      .all(row.channel_id, row.day) as unknown as ItemRow[];
    return {
      channelId: row.channel_id,
      day: row.day,
      organizerId: row.organizer_id,
      rootTs: row.root_ts,
      summaryTs: row.summary_ts,
      status: row.status === "closed" ? "closed" : "open",
      items: items.map((item) => ({
        userId: item.user_id,
        xmlId: item.xml_id,
        name: item.name,
        price: item.price,
        qty: item.qty,
      })),
    };
  }
}

interface OrderRow {
  channel_id: string;
  day: string;
  organizer_id: string;
  root_ts: string | null;
  summary_ts: string | null;
  status: string;
}

interface ItemRow {
  user_id: string;
  xml_id: string;
  name: string;
  price: number;
  qty: number;
}

function key(channelId: string, day: string): string {
  return `${channelId}\0${day}`;
}

function clone(order: OrderRecord): DayOrder {
  return {
    channelId: order.channelId,
    day: order.day,
    organizerId: order.organizerId,
    rootTs: order.rootTs,
    summaryTs: order.summaryTs,
    status: order.status,
    items: order.items.map((item) => ({ ...item })),
  };
}
