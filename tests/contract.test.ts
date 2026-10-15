import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpVvClient } from "../src/vv/client.ts";
import { filterReadyFood } from "../src/vv/catalog.ts";

const live = process.env.LIVE_MCP === "1";

describe("live MCP contract", { skip: !live }, () => {
  it("exposes the tools v1 needs and discount items include category", async () => {
    const client = new McpVvClient({
      url: process.env.VV_MCP_URL ?? "https://mcp.vkusvill.ru/mcp",
      userAgent: process.env.VV_USER_AGENT ?? "slack-vkusvill-bot/1.0 (Node 24; group food order)",
    });
    const tools = await client.listToolNames();
    for (const name of [
      "vkusvill_products_discount",
      "vkusvill_products_search",
      "vkusvill_product_details",
      "vkusvill_cart_link_create",
      "vkusvill_product_analogs",
    ]) {
      assert.ok(tools.includes(name), name);
    }

    const page = await client.callTool("vkusvill_products_discount", { type: "card", page: 1, vvonly: 1 });
    const data = (page as { data?: { items?: unknown[]; meta?: { personalized?: boolean } } }).data;
    assert.ok(data?.items && data.items.length > 0);
    const first = data.items[0] as { category?: unknown };
    assert.ok(Array.isArray(first.category));
    assert.equal(data.meta?.personalized, false);
    assert.ok(filterReadyFood(data.items).every((item) => item.categoryIds.includes(50361)));
    await client.close();
  });
});
