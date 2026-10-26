import test from "node:test";
import assert from "node:assert/strict";
import { rc3Describe, rc3History, rc3ListSessions, rc3RpcRequest } from "../scripts/dsh-rc3.mjs";
import { summarizeHistory } from "../scripts/dsh-client.mjs";

function record(seq, type = "request/header", data = {}) {
  return { type: "event", event: { seq, type, data, time: seq + 1000 } };
}

function mockClient(replies) {
  const calls = [];
  return {
    calls,
    async rpc(method, payload) {
      calls.push({ method, payload });
      assert.ok(replies.length, `Unexpected RPC ${method}`);
      return replies.shift();
    },
  };
}

test("rc3 wire calls use slash endpoints and exact named argument wrappers", () => {
  assert.deepEqual(rc3RpcRequest("session.create", { cwd: "D:\\service" }), {
    method: "session/create", payload: { args: { request: { cwd: "D:\\service" } } },
  });
  assert.deepEqual(rc3RpcRequest("session.list", {}), {
    method: "session/list", payload: { args: { _request: {} } },
  });
  assert.deepEqual(rc3RpcRequest("session/modelCatalog"), {
    method: "session/modelCatalog", payload: { args: {} },
  });
  assert.deepEqual(rc3RpcRequest("session.cancel", { sessionId: "s" }), {
    method: "session/cancel", payload: { args: { request: { sessionId: "s" } } },
  });
  const input = { sessionId: "s", mode: "queue", content: [{ type: "text", text: "hello" }] };
  const request = rc3RpcRequest("session.prompt", input).payload.args.request;
  assert.match(request.requestId, /^[\da-f-]{36}$/);
  assert.equal(input.requestId, undefined);
  assert.equal(rc3RpcRequest("session.prompt", { ...input, requestId: "stable" })
    .payload.args.request.requestId, "stable");
});

test("describe reads the current provider selection without any model credential API", async () => {
  const catalog = { default: { provider: "qoder", model: "Qwen3.8-Flash" }, groups: [], failures: [] };
  const client = mockClient([catalog]);
  assert.deepEqual(await rc3Describe(client), {
    apiVersion: "0.2.1-rc.3", defaultModel: catalog.default, modelCatalog: catalog,
  });
  assert.deepEqual(client.calls, [{ method: "session.modelCatalog", payload: {} }]);
});

test("Session list retains projections used by the legacy summarizer", async () => {
  const value = { items: [{ sessionId: "s", projections: { values: { title: "Roundtrip" } } }] };
  assert.equal(await rc3ListSessions(mockClient([value])), value);
  await assert.rejects(rc3ListSessions(mockClient([{}])), { code: "invalid-response" });
});

test("history preserves turn/end and latest cursor after the final assistant message", async () => {
  const projections = { asOfSeq: 8, values: {} };
  const entries = [
    record(6, "assistant/message", { message: { content: [{ type: "text", text: "done" }] } }),
    record(7, "step/end"),
    record(8, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
  const client = mockClient([projections, { records: entries, hasMore: true }]);
  const raw = await rc3History(client, { sessionId: "s", maxMessages: 1 });
  const summary = summarizeHistory(raw);
  assert.equal(summary.latestSeq, 8);
  assert.equal(summary.messages[0].text, "done");
  assert.equal(summary.terminalEvents[0].reason.kind, "completed");
  assert.equal(summary.hasMore, true);
  assert.deepEqual(client.calls[1], {
    method: "session.page",
    payload: { address: { kind: "session", sessionId: "s" }, throughSeq: 8, maxMessages: 1 },
  });
});

test("waiting after a cursor covers older pages using the same projection cut", async () => {
  const client = mockClient([
    { asOfSeq: 9, values: {} },
    { records: [record(8), record(9, "turn/end", { reason: { kind: "completed" } })], hasMore: true },
    { records: [record(5, "tool/failed"), record(6), record(7)], hasMore: true },
    { records: [record(2), record(3), record(4)], hasMore: true },
  ]);
  const raw = await rc3History(client, { sessionId: "s", maxMessages: 1, afterSeq: 2 });
  assert.deepEqual(raw.events.map(({ event }) => event.seq), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(client.calls.slice(1).map(({ payload }) => [payload.throughSeq, payload.beforeSeq]),
    [[9, undefined], [9, 8], [9, 5]]);
  const summary = summarizeHistory(raw, { afterSeq: 2 });
  assert.equal(summary.errorEvents[0].seq, 5);
  assert.equal(summary.terminalEvents[0].seq, 9);
  assert.equal(summary.latestSeq, 9);
});

test("beforeSeq limits a slice and history exhaustion terminates backwards paging", async () => {
  const client = mockClient([
    { asOfSeq: 9, values: {} },
    { records: [record(3), record(4)], hasMore: true },
    { records: [record(0), record(1), record(2)], hasMore: false },
  ]);
  const history = await rc3History(client, { sessionId: "s", beforeSeq: 5, afterSeq: 0 });
  assert.deepEqual(history.events.map(({ event }) => event.seq), [0, 1, 2, 3, 4]);
  assert.equal(history.hasMore, false);
  assert.equal(summarizeHistory(history).latestSeq, 4);
  assert.equal(client.calls[1].payload.beforeSeq, 5);
});

test("empty and missing Sessions do not request an invalid page", async () => {
  const empty = mockClient([{ asOfSeq: -1, values: {} }]);
  assert.deepEqual((await rc3History(empty, { sessionId: "s" })).events, []);
  assert.equal(empty.calls.length, 1);
  await assert.rejects(rc3History(mockClient([null]), { sessionId: "s" }), { code: "session/not-found" });
});

test("malformed pages cannot silently lose terminal records or loop forever", async () => {
  for (const page of [
    { events: [], hasMore: false },
    { records: [], hasMore: true },
    { records: [record(3), record(2)], hasMore: false },
    { records: [record(5)], hasMore: false },
  ]) {
    await assert.rejects(rc3History(mockClient([{ asOfSeq: 4, values: {} }, page]), {
      sessionId: "s", afterSeq: 0,
    }), { code: "invalid-response" });
  }
});
