import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryOrdersRepo, SqliteOrdersRepo, addToOrder, cutoffDay } from "../src/orders.ts";
import type { OrdersRepo } from "../src/orders.ts";

const day = "2026-10-09";

const factories: { name: string; make: () => OrdersRepo }[] = [
  { name: "MemoryOrdersRepo", make: () => new MemoryOrdersRepo() },
  { name: "SqliteOrdersRepo", make: () => new SqliteOrdersRepo(":memory:") },
];

describe("OrdersRepo", () => {
  for (const factory of factories) {
    it(`${factory.name} keeps the first organizer and the day's lines`, () => {
      const repo = factory.make();
      const opened = repo.open({ channelId: "C1", day, organizerId: "U-org", rootTs: "111.1" });
      assert.equal(opened.organizerId, "U-org");
      const again = repo.open({ channelId: "C1", day, organizerId: "U-other", rootTs: "222.2" });
      assert.equal(again.organizerId, "U-org");
      assert.equal(again.rootTs, "111.1");

      const added = addToOrder(repo, "C1", day, {
        userId: "U2",
        xmlId: "118098",
        name: "Паста",
        price: 260,
      });
      assert.equal(added.ok, true);
      if (!added.ok) return;
      assert.equal(added.order.items[0]?.qty, 1);

      const more = addToOrder(repo, "C1", day, {
        userId: "U2",
        xmlId: "118098",
        name: "Паста",
        price: 260,
      });
      assert.equal(more.ok, true);
      if (!more.ok) return;
      assert.equal(more.order.items[0]?.qty, 2);

      repo.remove("C1", day, "U2", "118098");
      assert.equal(repo.get("C1", day)?.items.length, 0);
    });

    it(`${factory.name} refuses changes after close and drops orders older than 7 days`, () => {
      const repo = factory.make();
      repo.open({ channelId: "C1", day: "2026-10-01", organizerId: "U1", rootTs: "1" });
      repo.open({ channelId: "C1", day: "2026-10-09", organizerId: "U1", rootTs: "2" });
      repo.close("C1", "2026-10-09");
      const refused = addToOrder(repo, "C1", "2026-10-09", {
        userId: "U2",
        xmlId: "1",
        name: "Суп",
        price: 100,
      });
      assert.deepEqual(refused, { ok: false, reason: "closed" });

      const removed = repo.deleteOlderThan("2026-10-03");
      assert.equal(removed, 1);
      assert.equal(repo.get("C1", "2026-10-01"), null);
      assert.ok(repo.get("C1", "2026-10-09"));
    });
  }
});

describe("cutoffDay", () => {
  it("is seven Moscow calendar days before the given instant", () => {
    const cutoff = cutoffDay(new Date("2026-10-09T21:30:00.000Z"), "Europe/Moscow", 7);
    assert.equal(cutoff, "2026-10-03");
  });
});
