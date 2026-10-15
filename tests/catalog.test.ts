import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkCart,
  filterReadyFood,
  mergeCartLines,
  normalizeProduct,
  READY_FOOD_CATEGORY_ID,
  sortByDiscount,
  TtlCache,
  VvCatalog,
} from "../src/vv/catalog.ts";
import { hostileName, notReadyFood, readyFood, readyFoodLowDiscount } from "./fixtures/products.ts";

describe("normalizeProduct", () => {
  it("decodes nbsp and quotes, rounds prices, keeps ready-food category", () => {
    const product = normalizeProduct(readyFood);
    assert.ok(product);
    assert.equal(product.name, 'Паста "Карбонара"');
    assert.equal(product.priceCurrent, 260);
    assert.equal(product.priceOld, 320);
    assert.equal(product.discountPercent, 18.6);
    assert.equal(product.xmlId, "118098");
    assert.equal(product.xmlIdNum, 118098);
    assert.equal(product.weight, "0.3 кг");
    assert.equal(product.rating, 4.6);
    assert.equal(product.url, "https://vkusvill.ru/goods/pasta-karbonara-118098/");
    assert.ok(product.categoryIds.includes(READY_FOOD_CATEGORY_ID));
  });

  it("drops urls outside vkusvill.ru", () => {
    const product = normalizeProduct(hostileName);
    assert.ok(product);
    assert.equal(product.url, null);
  });

  it("returns null when price or xml_id is missing", () => {
    assert.equal(normalizeProduct({ id: 1, name: "Без цены", category: [] }), null);
    assert.equal(normalizeProduct({ id: 1, xml_id: 0, name: "Ноль", price: { current: 10 } }), null);
  });
});

describe("filterReadyFood", () => {
  it("keeps only items whose category chain contains 50361", () => {
    const products = filterReadyFood([readyFood, notReadyFood, readyFoodLowDiscount, { name: "мусор" }]);
    assert.deepEqual(
      products.map((item) => item.xmlId),
      ["118098", "200"],
    );
  });
});

describe("sortByDiscount", () => {
  it("orders by discount percent descending", () => {
    const products = filterReadyFood([readyFoodLowDiscount, readyFood]);
    assert.deepEqual(
      sortByDiscount(products).map((item) => item.xmlId),
      ["118098", "200"],
    );
  });
});

describe("cart lines", () => {
  it("merges the same xml_id and splits quantity above 40", () => {
    const lines = mergeCartLines([
      { xmlIdNum: 5, qty: 30 },
      { xmlIdNum: 5, qty: 15 },
      { xmlIdNum: 6, qty: 2 },
    ]);
    assert.deepEqual(lines, [
      { xml_id: 5, q: 40 },
      { xml_id: 5, q: 5 },
      { xml_id: 6, q: 2 },
    ]);
  });

  it("chunks a cart into groups of 20", () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ xml_id: index + 1, q: 1 }));
    const chunks = chunkCart(items, 20);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.length, 20);
    assert.equal(chunks[1]?.length, 5);
  });

  it("returns no chunks for an empty cart", () => {
    assert.deepEqual(chunkCart([], 20), []);
  });
});

describe("VvCatalog", () => {
  it("reads every discount page, keeps ready food, and caches the result", async () => {
    const calls: string[] = [];
    const tools = {
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push(`${name}:${String(args.type)}:${String(args.page)}`);
        if (name !== "vkusvill_products_discount") throw new Error(name);
        if (args.type === "card" && args.page === 1) {
          return { ok: true, data: { items: [readyFood, notReadyFood], meta: { has_more: true, personalized: false } } };
        }
        if (args.type === "card" && args.page === 2) {
          return { ok: true, data: { items: [readyFoodLowDiscount], meta: { has_more: false } } };
        }
        return { ok: true, data: { items: [], meta: { has_more: false } } };
      },
    };
    const catalog = new VvCatalog(tools, new TtlCache(() => 1_000), {
      discountTtlMs: 1_800_000,
      searchTtlMs: 600_000,
    });
    const first = await catalog.readyFoodDiscounts();
    assert.deepEqual(
      first.map((item) => item.xmlId),
      ["118098", "200"],
    );
    await catalog.readyFoodDiscounts();
    assert.deepEqual(
      calls.filter((call) => call.startsWith("vkusvill_products_discount")),
      [
        "vkusvill_products_discount:card:1",
        "vkusvill_products_discount:card:2",
        "vkusvill_products_discount:quantity:1",
      ],
    );
  });

  it("returns at most three ready-food search hits", async () => {
    const tools = {
      async callTool() {
        return {
          ok: true,
          data: {
            items: [readyFood, readyFoodLowDiscount, hostileName, notReadyFood, { ...readyFood, xml_id: 9, id: 9, name: "Четвёртое" }],
            meta: { has_more: false },
          },
        };
      },
    };
    const catalog = new VvCatalog(tools, new TtlCache(), { discountTtlMs: 1, searchTtlMs: 1 });
    const found = await catalog.searchReadyFood("карбонара");
    assert.equal(found.length, 3);
    assert.ok(found.every((item) => item.categoryIds.includes(READY_FOOD_CATEGORY_ID)));
  });

  it("asks for a share link per chunk of 20", async () => {
    const calls: unknown[] = [];
    const tools = {
      async callTool(_name: string, args: Record<string, unknown>) {
        calls.push(args.products);
        const products = args.products as unknown[];
        return { ok: true, data: { link: `https://vkusvill.ru/?share_basket=${products.length}` } };
      },
    };
    const catalog = new VvCatalog(tools, new TtlCache(), { discountTtlMs: 1, searchTtlMs: 1 });
    const lines = Array.from({ length: 21 }, (_, index) => ({ xmlIdNum: index + 1, qty: 1 }));
    const links = await catalog.createCartLinks(lines);
    assert.equal(calls.length, 2);
    assert.equal((calls[0] as unknown[]).length, 20);
    assert.deepEqual(links, ["https://vkusvill.ru/?share_basket=20", "https://vkusvill.ru/?share_basket=1"]);
  });
});
