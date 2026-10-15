export const READY_FOOD_CATEGORY_ID = 50361;
const MAX_CART_QTY = 40;
const MAX_DISCOUNT_PAGES = 20;

export interface Product {
  id: number;
  xmlId: string;
  xmlIdNum: number;
  name: string;
  priceCurrent: number;
  priceOld: number | null;
  discountPercent: number | null;
  discountInfo: string | null;
  rating: number | null;
  weight: string | null;
  url: string | null;
  categoryIds: number[];
}

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class TtlCache {
  private readonly store = new Map<string, { value: unknown; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function vkusvillUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "vkusvill.ru" && url.hostname !== "www.vkusvill.ru") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export function shareBasketUrl(value: unknown): string | null {
  const url = vkusvillUrl(value);
  if (!url) return null;
  const id = new URL(url).searchParams.get("share_basket");
  if (!id) return null;
  return url;
}

export function normalizeProduct(raw: unknown): Product | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const xmlIdNum = positiveInt(item.xml_id);
  const id = positiveInt(item.id) ?? xmlIdNum;
  const price = item.price;
  if (!xmlIdNum || !id || !price || typeof price !== "object") return null;
  const current = money((price as { current?: unknown }).current);
  if (current == null || typeof item.name !== "string" || item.name.trim() === "") return null;
  const old = money((price as { old?: unknown }).old);
  const discountRaw = (price as { discount_percent?: unknown }).discount_percent;
  const discountPercent = typeof discountRaw === "number" && Number.isFinite(discountRaw) ? discountRaw : null;
  const infoRaw = (price as { discount_info?: unknown }).discount_info;
  const ratingRaw = item.rating;
  const average =
    ratingRaw && typeof ratingRaw === "object" && typeof (ratingRaw as { average?: unknown }).average === "number"
      ? (ratingRaw as { average: number }).average
      : null;
  return {
    id,
    xmlId: String(xmlIdNum),
    xmlIdNum,
    name: decodeHtml(item.name),
    priceCurrent: current,
    priceOld: old,
    discountPercent,
    discountInfo: typeof infoRaw === "string" && infoRaw.trim() ? decodeHtml(infoRaw) : null,
    rating: average,
    weight: formatWeight(item.weight),
    url: vkusvillUrl(item.url),
    categoryIds: categoryIds(item.category),
  };
}

export function filterReadyFood(items: unknown[], categoryId = READY_FOOD_CATEGORY_ID): Product[] {
  const products: Product[] = [];
  for (const item of items) {
    const product = normalizeProduct(item);
    if (product?.categoryIds.includes(categoryId)) products.push(product);
  }
  return products;
}

export function sortByDiscount(products: Product[]): Product[] {
  return [...products].sort((a, b) => {
    const delta = (b.discountPercent ?? -1) - (a.discountPercent ?? -1);
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name, "ru");
  });
}

export function mergeCartLines(items: { xmlIdNum: number; qty: number }[]): { xml_id: number; q: number }[] {
  const totals = new Map<number, number>();
  const order: number[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.xmlIdNum) || item.xmlIdNum < 1 || item.qty < 1) continue;
    if (!totals.has(item.xmlIdNum)) order.push(item.xmlIdNum);
    totals.set(item.xmlIdNum, (totals.get(item.xmlIdNum) ?? 0) + item.qty);
  }
  const lines: { xml_id: number; q: number }[] = [];
  for (const xmlId of order) {
    let left = totals.get(xmlId) ?? 0;
    while (left > 0) {
      const q = Math.min(MAX_CART_QTY, left);
      lines.push({ xml_id: xmlId, q });
      left -= q;
    }
  }
  return lines;
}

export function chunkCart<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class VvCatalog {
  constructor(
    private readonly tools: ToolCaller,
    private readonly cache: TtlCache,
    private readonly options: { discountTtlMs: number; searchTtlMs: number; categoryId?: number },
  ) {}

  async readyFoodDiscounts(): Promise<Product[]> {
    const key = `discounts:${this.options.categoryId ?? READY_FOOD_CATEGORY_ID}`;
    const cached = this.cache.get<Product[]>(key);
    if (cached) return cached;
    const raw = [
      ...(await this.collectDiscount("card")),
      ...(await this.collectDiscount("quantity")),
    ];
    const products = sortByDiscount(dedupe(filterReadyFood(raw, this.options.categoryId)));
    this.cache.set(key, products, this.options.discountTtlMs);
    return products;
  }

  async searchReadyFood(query: string): Promise<Product[]> {
    const q = query.trim().slice(0, 255);
    if (!q) return [];
    const key = `search:${q.toLocaleLowerCase("ru")}`;
    const cached = this.cache.get<Product[]>(key);
    if (cached) return cached;
    const found: Product[] = [];
    for (let page = 1; page <= 2 && found.length < 3; page += 1) {
      const envelope = await this.tools.callTool("vkusvill_products_search", {
        q,
        page,
        limit: 10,
        vvonly: 1,
        mode: "custom",
        fields: ["id", "xml_id", "name", "price", "weight", "rating", "url", "category"],
      });
      const pageData = readPage(envelope);
      found.push(...filterReadyFood(pageData.items, this.options.categoryId));
      if (!pageData.hasMore) break;
    }
    const top = dedupe(found).slice(0, 3);
    this.cache.set(key, top, this.options.searchTtlMs);
    return top;
  }

  async createCartLinks(lines: { xmlIdNum: number; qty: number }[]): Promise<string[]> {
    const chunks = chunkCart(mergeCartLines(lines), 20);
    const links: string[] = [];
    for (const products of chunks) {
      const envelope = await this.tools.callTool("vkusvill_cart_link_create", { products });
      const link = readLink(envelope);
      if (!link) throw new Error("cart link missing");
      links.push(link);
    }
    return links;
  }

  private async collectDiscount(type: "card" | "quantity"): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_DISCOUNT_PAGES; page += 1) {
      const envelope = await this.tools.callTool("vkusvill_products_discount", {
        type,
        page,
        vvonly: 1,
      });
      const pageData = readPage(envelope);
      items.push(...pageData.items);
      if (!pageData.hasMore || pageData.items.length === 0) break;
    }
    return items;
  }
}

function dedupe(products: Product[]): Product[] {
  const map = new Map<string, Product>();
  for (const product of products) {
    const previous = map.get(product.xmlId);
    if (!previous || (product.discountPercent ?? -1) > (previous.discountPercent ?? -1)) {
      map.set(product.xmlId, product);
    }
  }
  return [...map.values()];
}

function readPage(envelope: unknown): { items: unknown[]; hasMore: boolean } {
  if (!envelope || typeof envelope !== "object") return { items: [], hasMore: false };
  const root = envelope as { data?: unknown; meta?: { has_more?: boolean } };
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as { items?: unknown; meta?: { has_more?: boolean } })
      : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const hasMore = Boolean(data.meta?.has_more ?? root.meta?.has_more);
  return { items, hasMore };
}

function readLink(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== "object") return null;
  const data = (envelope as { data?: { link?: unknown } }).data;
  return shareBasketUrl(data?.link);
}

function positiveInt(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 999_999_999) return null;
  return number;
}

function money(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function categoryIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "number" && Number.isInteger(id)) ids.push(id);
  }
  return ids;
}

function formatWeight(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return decodeHtml(value);
  if (!value || typeof value !== "object") return null;
  const weight = value as { value?: unknown; unit?: unknown };
  if (typeof weight.value === "number" && Number.isFinite(weight.value) && typeof weight.unit === "string") {
    return `${weight.value} ${decodeHtml(weight.unit)}`;
  }
  return null;
}
