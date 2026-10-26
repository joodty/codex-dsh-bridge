import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DshClient, summarizeHistory } from "../scripts/dsh-client.mjs";
import { rc3History } from "../scripts/dsh-rc3.mjs";

function event(seq, type, data = {}) {
  return { type: "event", event: { seq, time: seq, type, data } };
}
function user(seq, requestId) {
  return event(seq, "user/message", {
    source: { kind: "user", rpcId: requestId }, content: [{ type: "text", text: requestId }],
  });
}
function assistant(seq, text, turn = 2) {
  return event(seq, "assistant/message", { turn, message: { content: [{ type: "text", text }] } });
}
function terminal(seq, turn, kind = "completed") {
  return event(seq, "turn/end", { turn, reason: { kind } });
}
function summary(events) {
  return { sessionId: "s", ...summarizeHistory({ events }) };
}
function fakeClient() {
  const client = Object.create(DshClient.prototype);
  client.listSessions = async () => [{ sessionId: "s", running: true }];
  return client;
}

test("queued request ignores old errors and turn completion until its user event is consumed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = fakeClient();
  const old = [assistant(11, "old result", 1), event(12, "tool/failed"), terminal(13, 1)];
  const target = [...old, event(14, "turn/start", { turn: 2 }), user(15, "target"), assistant(16, "target result")];
  const histories = [summary(old), summary(target), summary([...target, terminal(17, 2)])];
  let polls = 0;
  client.getMessages = async options => {
    assert.equal(options.requestId, "target");
    return histories[polls++];
  };
  let settled = false;
  const waiting = client.waitForSession({ sessionId: "s", afterSeq: 10, requestId: "target" })
    .then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(polls, 1);
  assert.equal(settled, false);
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(polls, 2);
  assert.equal(settled, false);
  t.mock.timers.tick(2000);
  const result = await waiting;
  assert.equal(result.completed, true);
  assert.equal(result.requestId, "target");
  assert.deepEqual(result.messages.map(message => message.text), ["target", "target result"]);
  assert.deepEqual(result.terminalEvents.map(marker => marker.turn), [2]);
  assert.deepEqual(result.errorEvents, []);
});

test("correlation chooses the first terminal after consumption and excludes subsequent turns", async () => {
  const client = fakeClient();
  client.getMessages = async () => summary([
    terminal(3, 1), event(4, "turn/start", { turn: 2 }), user(5, "target"),
    assistant(6, "target result"), terminal(7, 2),
    user(8, "another"), assistant(9, "unrelated", 3), event(10, "agent/error"), terminal(11, 3),
  ]);
  const result = await client.waitForSession({ sessionId: "s", requestId: "target" });
  assert.equal(result.completed, true);
  assert.deepEqual(result.terminalEvents.map(marker => marker.seq), [7]);
  assert.deepEqual(result.messages.map(message => message.text), ["target", "target result"]);
  assert.deepEqual(result.errorEvents, []);
});

test("steering correlates with the active turn even if its start predates the cursor", async () => {
  const client = fakeClient();
  client.getMessages = async () => summary([user(12, "steer"), assistant(13, "steered", 4), terminal(14, 4)]);
  const result = await client.waitForSession({ sessionId: "s", afterSeq: 10, requestId: "steer" });
  assert.equal(result.terminalEvents[0].turn, 4);
  assert.equal(result.messages.at(-1).text, "steered");
});

test("a target request error is reported while unrelated earlier errors are ignored", async () => {
  const client = fakeClient();
  client.getMessages = async () => summary([event(2, "agent/error"), user(5, "target"), event(6, "agent/error")]);
  const result = await client.waitForSession({ sessionId: "s", requestId: "target" });
  assert.equal(result.status, "error");
  assert.deepEqual(result.errorEvents.map(error => error.seq), [6]);
});

test("legacy waits without requestId retain cursor-based completion", async () => {
  const client = fakeClient();
  client.getMessages = async () => summary([terminal(5, 1)]);
  const result = await client.waitForSession({ sessionId: "s", afterSeq: 3 });
  assert.equal(result.completed, true);
  assert.equal(result.requestId, undefined);
});

test("send returns the same request identity used by the authenticated prompt", async () => {
  const client = fakeClient();
  client.localAuth = {};
  client.getMessages = async () => ({ latestSeq: 9 });
  let submitted;
  client.rpc = async (method, payload) => { assert.equal(method, "session.prompt"); submitted = payload; return { accepted: true }; };
  const sent = await client.sendMessage({ sessionId: "s", text: "task" });
  assert.equal(sent.requestId, submitted.requestId);
  assert.match(sent.requestId, /^[\da-f-]{36}$/);
  assert.equal(sent.afterSeq, 9);
});

test("RPC envelope and rc3 prompt request share the same identity", async t => {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.rpcId, "same-id");
    assert.equal(body.payload.args.request.requestId, "same-id");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = fakeClient();
  client.localAuth = { headers: async () => ({}) };
  client.baseUrl = new URL(`http://127.0.0.1:${server.address().port}`);
  client.requestTimeoutMs = 1000;
  assert.deepEqual(await client.rpc("session.prompt", { requestId: "same-id", sessionId: "s" }), { accepted: true });
});

test("request-only history search pages backwards until the consumed message is found", async () => {
  const replies = [
    { asOfSeq: 9, values: {} },
    { records: [assistant(8, "answer"), terminal(9, 2)], hasMore: true },
    { records: [user(5, "target"), event(6, "request/header"), event(7, "step/start")], hasMore: true },
  ];
  const calls = [];
  const client = { async rpc(method, payload) { calls.push({ method, payload }); return replies.shift(); } };
  const history = await rc3History(client, { sessionId: "s", requestId: "target", maxMessages: 1 });
  assert.deepEqual(history.events.map(record => record.event.seq), [5, 6, 7, 8, 9]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].payload.beforeSeq, 8);
});

test("dispatch passes correlation through and keeps substantive text before an empty tool message", async () => {
  const client = fakeClient();
  client.createSession = async () => ({ sessionId: "s" });
  client.sendMessage = async () => ({ accepted: true, afterSeq: 3, requestId: "target" });
  client.waitForSession = async options => {
    assert.equal(options.requestId, "target");
    return {
      completed: true, status: "completed", timedOut: false, session: { sessionId: "s" }, latestSeq: 9,
      messages: [{ role: "assistant", text: "useful answer" }, { role: "assistant", text: "  " }],
      terminalEvents: [], errorEvents: [],
    };
  };
  const result = await client.dispatch({ text: "task" });
  assert.equal(result.finalAssistantText, "useful answer");
  assert.equal(result.requestId, "target");
  assert.equal(result.afterSeq, 3);
});

test("dispatch awaits both admission receipts before prompting and waiting without sending callbacks to RPC", async () => {
  const client = fakeClient();
  const steps = [];
  let receiptCount = 0;
  client.createSession = async options => {
    assert.equal(options.onAdmitted, undefined);
    steps.push("create");
    return { sessionId: "s" };
  };
  client.sendMessage = async options => {
    assert.equal(options.onAdmitted, undefined);
    assert.equal(receiptCount, 1);
    steps.push("prompt");
    return { accepted: true, afterSeq: 3, requestId: "target" };
  };
  client.waitForSession = async options => {
    assert.equal(options.onAdmitted, undefined);
    assert.equal(receiptCount, 2);
    steps.push("wait");
    return { messages: [], terminalEvents: [], errorEvents: [], status: "completed" };
  };
  const admissions = [];
  const result = await client.dispatch({ text: "task", onAdmitted: async admission => {
    steps.push("receipt-start");
    await new Promise(resolve => setImmediate(resolve));
    admissions.push(admission);
    receiptCount++;
    steps.push("receipt-end");
  } });
  assert.deepEqual(admissions, [{ sessionId: "s" }, { sessionId: "s", requestId: "target", afterSeq: 3 }]);
  assert.deepEqual(steps, ["create", "receipt-start", "receipt-end", "prompt", "receipt-start", "receipt-end", "wait"]);
  assert.equal(result.afterSeq, 3);
});

test("admission failures stop dispatch before the next backend operation and retain known identities", async () => {
  for (const failingReceipt of [1, 2]) {
    const client = fakeClient();
    let prompts = 0;
    let waits = 0;
    let receipts = 0;
    client.createSession = async () => ({ sessionId: "recoverable" });
    client.sendMessage = async () => { prompts++; return { requestId: "target", afterSeq: 9 }; };
    client.waitForSession = async () => { waits++; };
    await assert.rejects(client.dispatch({ text: "task", onAdmitted: async () => {
      receipts++;
      if (receipts === failingReceipt) throw new Error("disk failure secret");
    } }), error => {
      assert.equal(error.code, "admission-callback-failed");
      assert.deepEqual(error.details.admission, failingReceipt === 1 ? { sessionId: "recoverable" }
        : { sessionId: "recoverable", requestId: "target", afterSeq: 9 });
      assert.ok(!error.message.includes("secret"));
      return true;
    });
    assert.equal(prompts, failingReceipt - 1);
    assert.equal(waits, 0);
  }
  const client = fakeClient();
  client.createSession = async () => assert.fail("Invalid callback must fail before creating a session");
  await assert.rejects(client.dispatch({ text: "task", onAdmitted: true }), { code: "invalid-argument" });
});

test("dispatch retains admitted session identity when prompt or wait loses its connection", async () => {
  for (const failAt of ["sendMessage", "waitForSession"]) {
    const client = fakeClient();
    const receipts = [];
    client.createSession = async () => ({ sessionId: "recoverable" });
    client.sendMessage = async () => ({ requestId: "target", afterSeq: 9 });
    client[failAt] = async () => { throw new Error("lost transport"); };
    await assert.rejects(client.dispatch({ text: "task", onAdmitted: async receipt => receipts.push(receipt) }), error => {
      assert.equal(error.details.admission.sessionId, "recoverable");
      assert.equal(receipts[0].sessionId, "recoverable");
      if (failAt === "waitForSession") {
        assert.equal(receipts[1].requestId, "target");
        assert.equal(error.details.admission.afterSeq, 9);
      }
      return true;
    });
  }
});
