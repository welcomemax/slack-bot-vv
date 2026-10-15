import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpFailure, extractSupportId, messageForStatus, withHttpPolicy } from "../src/vv/client.ts";

describe("messageForStatus", () => {
  it("explains 403, 429 and 5xx without a support id", () => {
    assert.match(messageForStatus(403), /заблокировал/);
    assert.match(messageForStatus(429), /попробуй/);
    assert.match(messageForStatus(503), /не отвечает/);
    assert.equal(messageForStatus(403).includes("support"), false);
  });
});

describe("extractSupportId", () => {
  it("reads a QRATOR support id from the error body", () => {
    assert.equal(extractSupportId("Access Blocked. Support ID: abc-123"), "abc-123");
    assert.equal(extractSupportId("no id here"), undefined);
  });
});

describe("withHttpPolicy", () => {
  it("does not retry 403 and logs the support id", async () => {
    let calls = 0;
    const logged: { status: number; supportId?: string }[] = [];
    await assert.rejects(
      () =>
        withHttpPolicy(
          async () => {
            calls += 1;
            throw { name: "StreamableHTTPError", code: 403, message: "Access Blocked. Support ID: sup-9" };
          },
          { log: (entry) => logged.push(entry), sleep: async () => {} },
        ),
      (err: unknown) => {
        assert.ok(err instanceof HttpFailure);
        assert.equal(err.status, 403);
        assert.equal(err.supportId, "sup-9");
        assert.match(err.userMessage, /заблокировал/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(logged, [{ status: 403, supportId: "sup-9" }]);
  });

  it("retries 429 twice and then fails with a clear message", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await assert.rejects(
      () =>
        withHttpPolicy(
          async () => {
            calls += 1;
            throw { name: "StreamableHTTPError", code: 429, message: "Too Many Requests" };
          },
          { sleep: async (ms) => void sleeps.push(ms) },
        ),
      (err: unknown) => err instanceof HttpFailure && err.status === 429 && /попробуй/.test(err.userMessage),
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it("retries 5xx twice", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withHttpPolicy(
          async () => {
            calls += 1;
            throw { name: "StreamableHTTPError", code: 502, message: "bad gateway" };
          },
          { sleep: async () => {} },
        ),
      (err: unknown) => err instanceof HttpFailure && err.status === 502,
    );
    assert.equal(calls, 3);
  });

  it("does not retry a successful call", async () => {
    let calls = 0;
    const value = await withHttpPolicy(async () => {
      calls += 1;
      return "ok";
    });
    assert.equal(value, "ok");
    assert.equal(calls, 1);
  });
});
