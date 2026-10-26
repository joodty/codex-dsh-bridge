import { randomUUID } from "node:crypto";

function invalidResponse(message) {
  const error = new Error(`DSH rc3 ${message}`);
  error.code = "invalid-response";
  return error;
}

/** Translate the bridge's flat calls to rc3's named Typert arguments. */
export function rc3RpcRequest(method, payload = {}) {
  const endpoint = method.replaceAll(".", "/");
  if (endpoint === "workspaceFiles/read") {
    return { method: endpoint, payload: { args: {
      workspaceFileScopeId: payload.sessionId,
      path: payload.path,
      range: payload.range,
    } } };
  }
  if (endpoint === "session/modelCatalog") {
    return { method: endpoint, payload: { args: {} } };
  }
  const request = endpoint === "session/prompt"
    ? { ...payload, requestId: payload.requestId ?? randomUUID() }
    : payload;
  return {
    method: endpoint,
    payload: { args: { [endpoint === "session/list" ? "_request" : "request"]: request } },
  };
}

/** rc3 has no host.describe Remote; its model catalog identifies the live selection. */
export async function rc3Describe(client) {
  const catalog = await client.rpc("session.modelCatalog", {});
  if (!catalog || typeof catalog.default?.provider !== "string"
    || typeof catalog.default?.model !== "string" || !Array.isArray(catalog.groups)) {
    throw invalidResponse("returned an invalid model catalog.");
  }
  return {
    apiVersion: "0.2.1-rc.3",
    defaultModel: catalog.default,
    modelCatalog: catalog,
  };
}

export async function rc3ListSessions(client) {
  const value = await client.rpc("session.list", {});
  if (!Array.isArray(value?.items)) {
    throw invalidResponse("returned an invalid Session list.");
  }
  return value;
}

/**
 * Page against one immutable projection cut. While waiting after a known cursor,
 * fetch older pages until that cursor is covered so intermediate errors and a
 * turn/end cannot disappear behind the newest message window.
 */
export async function rc3History(client, {
  sessionId,
  beforeSeq,
  maxMessages = 30,
  afterSeq = -1,
  requestId,
}) {
  const projections = await client.rpc("session.projections", { sessionId });
  if (projections === null) {
    const error = new Error(`DSH session not found: ${sessionId}`);
    error.code = "session/not-found";
    throw error;
  }
  const throughSeq = projections?.asOfSeq;
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) {
    throw invalidResponse("returned an invalid Session projection cursor.");
  }
  if (throughSeq === -1 || beforeSeq === 0) {
    return { events: [], hasMore: false, projections };
  }

  let cursor = beforeSeq;
  let events = [];
  let hasMore = false;
  while (true) {
    const request = {
      address: { kind: "session", sessionId },
      throughSeq,
      maxMessages,
      ...(cursor === undefined ? {} : { beforeSeq: cursor }),
    };
    const page = await client.rpc("session.page", request);
    if (!Array.isArray(page?.records) || typeof page.hasMore !== "boolean") {
      throw invalidResponse("returned an invalid Session history page.");
    }
    let previousSeq = -1;
    const upperBound = Math.min(throughSeq + 1, cursor ?? throughSeq + 1);
    for (const record of page.records) {
      const event = record?.event;
      if (record?.type !== "event" || !Number.isSafeInteger(event?.seq)
        || event.seq < 0 || event.seq <= previousSeq || event.seq >= upperBound
        || typeof event.type !== "string") {
        throw invalidResponse("returned invalid or unordered Session history records.");
      }
      previousSeq = event.seq;
    }
    const firstSeq = page.records[0]?.event.seq;
    if (page.hasMore && firstSeq === undefined) {
      throw invalidResponse("returned an empty history page with more records pending.");
    }
    events = [...page.records, ...events];
    hasMore = page.hasMore;
    const requestFound = requestId !== undefined && events.some(record =>
      record.event.type === "user/message" && record.event.data?.source?.rpcId === requestId);
    if (!hasMore || (afterSeq >= 0 ? firstSeq <= afterSeq + 1 : requestId === undefined || requestFound)) break;
    cursor = firstSeq;
  }
  return { events, hasMore, projections };
}
