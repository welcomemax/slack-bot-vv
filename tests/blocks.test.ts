import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cartFallbackMessage,
  discountMessage,
  escapeMrkdwn,
  myOrderMessage,
  searchMessage,
  stripMention,
  summaryMessage,
  MAX_BLOCKS,
  MAX_BLOCK_TEXT,
} from "../src/blocks.ts";
import { filterReadyFood, sortByDiscount } from "../src/vv/catalog.ts";
import { hostileName, readyFood, readyFoodLowDiscount } from "./fixtures/products.ts";
import type { OrderItem } from "../src/orders.ts";

function textOf(block: { text?: { text?: string }; elements?: { text?: string }[] }): string {
  const parts = [block.text?.text ?? ""];
  for (const element of block.elements ?? []) {
    if (element.text) parts.push(element.text);
  }
  return parts.join("\n");
}

function assertBlockLimits(blocks: unknown[]): void {
  assert.ok(blocks.length <= MAX_BLOCKS, `blocks ${blocks.length}`);
  const serialized = JSON.stringify(blocks);
  assert.equal(serialized.includes("<!channel>"), false);
  assert.equal(serialized.includes("<@U1>"), false);
  for (const block of blocks) {
    const text = textOf(block as { text?: { text?: string }; elements?: { text?: string }[] });
    assert.ok(text.length <= MAX_BLOCK_TEXT, text.slice(0, 80));
  }
}

describe("escapeMrkdwn", () => {
  it("renders channel and user mentions as text", () => {
    const escaped = escapeMrkdwn("<!channel> <@U1>");
    assert.equal(escaped, "&lt;!channel&gt; &lt;@U1&gt;");
    assert.equal(escaped.includes("<!channel>"), false);
    assert.equal(escaped.includes("<@U1>"), false);
  });
});

describe("discountMessage", () => {
  const products = sortByDiscount(filterReadyFood([readyFood, readyFoodLowDiscount, hostileName]));

  it("shows the top dishes with a want button and a price context", () => {
    const message = discountMessage(products, { top: 12 });
    assert.match(message.text, /вкусвилл :cherries:/);
    assert.match(message.text, /Цены общие/);
    const joined = JSON.stringify(message.blocks);
    assert.match(joined, /Карбонара/);
    assert.match(joined, /~320~ 260 ₽/);
    assert.match(joined, /Хочу/);
    assert.match(joined, /xml_id|118098/);
    const want = message.blocks.find(
      (block) => block.type === "section" && "accessory" in block && block.accessory?.type === "button",
    );
    assert.equal(want && "accessory" in want ? want.accessory?.value : undefined, "118098");
    assertBlockLimits(message.blocks);
  });

  it("adds an overflow button after the top slice and stays within block limits", () => {
    const many = Array.from({ length: 30 }, (_, index) => {
      const product = filterReadyFood([
        {
          ...readyFood,
          id: index + 1,
          xml_id: 1000 + index,
          name: index === 0 ? hostileName.name : `Блюдо ${index}`,
          price: { ...readyFood.price, discount_percent: 30 - index },
        },
      ])[0];
      assert.ok(product);
      return product;
    });
    const message = discountMessage(many, { top: 12 });
    assert.ok(message.blocks.length <= MAX_BLOCKS);
    assert.match(JSON.stringify(message.blocks), /Ещё/);
    assert.equal(message.blocks.filter((block) => block.type === "section").length <= 14, true);
    assertBlockLimits(message.blocks);
  });

  it("says when there are no ready-food discounts", () => {
    const message = discountMessage([], { top: 12 });
    assert.match(JSON.stringify(message.blocks), /акций на готовую еду нет/);
    assertBlockLimits(message.blocks);
  });
});

describe("search and order messages", () => {
  it("strips the bot mention and keeps the query", () => {
    assert.equal(stripMention("<@U0BOT>  карбонара "), "карбонара");
  });

  it("puts one to three search hits in the thread payload", () => {
    const products = filterReadyFood([readyFood, readyFoodLowDiscount, hostileName]);
    const message = searchMessage(products.slice(0, 3));
    const wants = message.blocks.filter(
      (block) => block.type === "section" && "accessory" in block && block.accessory?.type === "button",
    );
    assert.equal(wants.length, 3);
    assertBlockLimits(message.blocks);
  });

  it("does not mention people in the summary", () => {
    const items: OrderItem[] = [
      { userId: "U1", xmlId: "118098", name: '<!channel> паста', price: 260, qty: 2 },
    ];
    const message = summaryMessage(items, new Map([["U1", "<@U1>"]]));
    const joined = JSON.stringify(message);
    assert.equal(joined.includes("<@"), false);
    assert.equal(joined.includes("<!"), false);
    assert.match(joined, /520 ₽/);
    assertBlockLimits(message.blocks);
  });

  it("builds my-order controls and a cart fallback with a total", () => {
    const items: OrderItem[] = [
      { userId: "U1", xmlId: "118098", name: "Паста", price: 260, qty: 1 },
    ];
    const mine = myOrderMessage(items);
    assert.match(JSON.stringify(mine.blocks), /Убрать/);
    assert.match(JSON.stringify(mine.blocks), /\+1/);
    const products = filterReadyFood([readyFood]);
    const fallback = cartFallbackMessage(products, items);
    assert.match(fallback.text, /1180|260/);
    assert.match(JSON.stringify(fallback.blocks), /vkusvill\.ru/);
    assertBlockLimits(mine.blocks);
    assertBlockLimits(fallback.blocks);
  });
});
