import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ToolLoopAgent, stepCountIs, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { planRequest } from "../planner";
import { registerHandlers } from "../handlers";
import { activeToolsForIntent, createCoreTools } from "./registry";
import { toolResultToModelText, type RinaToolResult } from "./results";
import { webTools } from "./web";
import { resolveWebProvider } from "./web-provider";

const SOURCE = "https://www.nasa.gov/mission/artemis-ii/";
const EXCERPT = `Artemis II is a crewed lunar flyby. Source: ${SOURCE}`;
type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };
type RequestRecord = { url: string; headers: Headers; rpc: Rpc };

function anonymous(t: TestContext) {
  for (const key of ["RINA_WEB_PROVIDER", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "PARALLEL_API_KEY"]) {
    const old = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}

// Exercise the real MCP SDK and tool registry; only the HTTP server is scripted.
function mcpServer(t: TestContext, reply?: (rpc: Rpc, signal?: AbortSignal | null) => unknown | Promise<unknown>) {
  const requests: RequestRecord[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const rpc: Rpc = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ url: String(url), headers: new Headers(init?.headers), rpc });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") {
      result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    } else if (rpc.method === "tools/list") {
      result = { tools: ["web_search", "web_fetch"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
    } else if (rpc.method === "tools/call") {
      result = reply ? await reply(rpc, init?.signal) : { content: [{ type: "text", text: EXCERPT }] };
    } else {
      assert.fail(`Unexpected MCP method: ${rpc.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  return requests;
}

async function execute(name: "researchWeb" | "webSearch" | "fetchWebpage", input: Record<string, string>, abortSignal?: AbortSignal) {
  const tools = createCoreTools() as ToolSet;
  const selected = tools[name];
  assert.ok(selected?.execute);
  return await selected.execute(input, { toolCallId: "test-call", messages: [], abortSignal }) as RinaToolResult;
}

test("provider resolution preserves credentials and explicit choices", (t) => {
  anonymous(t);
  assert.equal(resolveWebProvider({}), "parallel");
  assert.equal(resolveWebProvider({ AI_GATEWAY_API_KEY: "saved-key" }), "gateway");
  assert.equal(resolveWebProvider({ VERCEL_OIDC_TOKEN: "saved-oidc" }), "gateway");
  assert.equal(resolveWebProvider({ AI_GATEWAY_API_KEY: "  " }), "parallel");
  for (const provider of ["parallel", "gateway", "disabled"] as const) {
    assert.equal(resolveWebProvider({ RINA_WEB_PROVIDER: provider, AI_GATEWAY_API_KEY: "saved-key" }), provider);
  }
  assert.throws(() => resolveWebProvider({ RINA_WEB_PROVIDER: "typo" }), /RINA_WEB_PROVIDER/);
  process.env.AI_GATEWAY_API_KEY = "saved-key";
  assert.equal(createCoreTools().researchWeb, webTools.researchWeb);
  process.env.RINA_WEB_PROVIDER = "parallel";
  assert.notEqual(createCoreTools().researchWeb, webTools.researchWeb);
  assert.equal(createCoreTools().perplexitySearch, webTools.perplexitySearch);
});

test("anonymous registry search and fetch send MCP arguments and project headers", async (t) => {
  anonymous(t);
  const requests = mcpServer(t);
  const result = await execute("researchWeb", { query: "NASA Artemis II mission" });
  assert.equal(result.ok, true);
  assert.match(toolResultToModelText(result), /Artemis II/);
  assert.ok(toolResultToModelText(result).includes(SOURCE));
  const fetched = await execute("fetchWebpage", { url: "https://8.8.8.8/", question: "What is this?" });
  assert.equal(fetched.ok, true);
  assert.deepEqual(requests.filter((r) => r.rpc.method === "tools/call").map((r) => r.rpc.params), [
    { name: "web_search", arguments: { objective: "NASA Artemis II mission", search_queries: ["NASA Artemis II mission"] } },
    { name: "web_fetch", arguments: { urls: ["https://8.8.8.8/"], objective: "What is this?" } },
  ]);
  for (const request of requests) {
    assert.equal(request.url, "https://search.parallel.ai/mcp");
    assert.equal(request.headers.get("User-Agent"), "agent-rina/0.1.0 (+https://github.com/wdchenxyz/agent-rina)");
    assert.equal(request.headers.has("Authorization"), false);
  }
  assert.equal(requests.filter((r) => r.rpc.method === "initialize").length, 2);
  assert.equal(requests.filter((r) => r.rpc.method === "tools/list").length, 2);
});

test("scripted ToolLoopAgent consumes registry search evidence on its next step", async (t) => {
  anonymous(t);
  mcpServer(t);
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      calls += 1;
      if (calls > 1) {
        assert.ok(JSON.stringify(prompt).includes(EXCERPT), "MCP evidence must reach the model");
      }
      return {
        content: calls === 1
          ? [{ type: "tool-call" as const, toolCallId: "search-1", toolName: "researchWeb", input: JSON.stringify({ query: "NASA Artemis II mission" }) }]
          : [{ type: "text" as const, text: `Artemis II is a crewed lunar flyby (${SOURCE}).` }],
        finishReason: { unified: calls === 1 ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
      };
    },
  });
  const tools = createCoreTools() as ToolSet;
  const plan = planRequest("search for NASA Artemis II mission");
  const agent = new ToolLoopAgent({
    model,
    tools,
    stopWhen: stepCountIs(3),
    prepareStep: () => ({ activeTools: activeToolsForIntent(plan.intent).filter((name) => name in tools) }),
  });
  const result = await agent.generate({ prompt: "search for NASA Artemis II mission" });
  assert.equal(calls, 2);
  assert.equal(result.steps[0].toolResults[0].toolName, "researchWeb");
  assert.ok(result.text.includes(SOURCE));
});

test("disabled provider removes web tools from the registry without requests", (t) => {
  anonymous(t);
  const requests = mcpServer(t);
  process.env.RINA_WEB_PROVIDER = "disabled";
  const tools = createCoreTools();
  for (const name of ["researchWeb", "webSearch", "fetchWebpage", "perplexitySearch", "extractWebpageAssets"]) {
    assert.equal(name in tools, false);
  }
  assert.equal(requests.length, 0);
});

test("page reads reject unsafe URLs before contacting MCP", async (t) => {
  anonymous(t);
  const requests = mcpServer(t);
  for (const url of ["http://localhost:3000", "http://127.0.0.1/", "http://10.0.0.1/", "file:///etc/passwd", "https://user:pass@8.8.8.8/"]) {
    await assert.rejects(execute("fetchWebpage", { url }));
  }
  assert.equal(requests.length, 0);
});

test("MCP errors are failures with no provider fallback", async (t) => {
  anonymous(t);
  process.env.RINA_WEB_PROVIDER = "parallel";
  const requests = mcpServer(t, () => ({ isError: true, content: [{ type: "text", text: "Search quota exceeded" }] }));
  const result = await execute("researchWeb", { query: "current NASA news" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /quota/);
  assert.ok(requests.every((r) => r.url === "https://search.parallel.ai/mcp"));
});

test("empty MCP content is not a successful search", async (t) => {
  anonymous(t);
  mcpServer(t, () => ({ content: [] }));
  const result = await execute("researchWeb", { query: "current NASA news" });
  assert.equal(result.ok, false);
});

test("JSON source URLs reach the normal Rina citation consumer", async (t) => {
  anonymous(t);
  mcpServer(t, () => ({ content: [{ type: "text", text: JSON.stringify({ results: [{ url: SOURCE, title: "Artemis II", excerpts: [EXCERPT] }] }) }] }));
  const result = await execute("researchWeb", { query: "NASA Artemis II mission" });
  assert.deepEqual(result.citations, [{ url: SOURCE, title: "Artemis II" }]);
  assert.match(toolResultToModelText(result), /Sources:\n- Artemis II: https:/);
});

test("empty and error-only JSON payloads fail without discarding error details", async (t) => {
  anonymous(t);
  const error = { url: "https://8.8.8.8/", error_type: "fetch_error", content: "The page could not be fetched" };
  const replies = [{ results: [], errors: [error] }, { results: [] }, { errors: [error] }];
  const requests = mcpServer(t, () => ({ content: [{ type: "text", text: JSON.stringify(replies.shift()) }] }));
  for (let index = 0; index < 3; index += 1) {
    const result = await execute("fetchWebpage", { url: "https://8.8.8.8/" });
    assert.equal(result.ok, false);
    if (index !== 1) assert.match(toolResultToModelText(result), /The page could not be fetched/);
  }
  assert.equal(requests.filter((r) => r.rpc.method === "tools/call").length, 3);
  assert.ok(requests.every((r) => r.url === "https://search.parallel.ai/mcp"));
});

test("chat allowlists deny access before any search or agent execution", async (t) => {
  anonymous(t);
  const requests = mcpServer(t);
  const key = "BOT_ALLOWED_USER_IDS_SLACK";
  const saved = process.env[key];
  process.env[key] = "allowed-user";
  t.after(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
  type Bot = Parameters<typeof registerHandlers>[0];
  type Callback = Parameters<Bot["onNewMention"]>[0];
  let mention: Callback | undefined;
  registerHandlers({
    onNewMention: (callback: Callback) => { mention = callback; },
    onSubscribedMessage: () => undefined,
    onNewMessage: () => undefined,
  } as unknown as Bot);
  assert.ok(mention);
  await mention({ adapter: { name: "slack" }, id: "chat", subscribe: () => assert.fail("denied users must not subscribe") } as unknown as Parameters<Callback>[0],
    { author: { userId: "denied-user", isMe: false } } as Parameters<Callback>[1]);
  assert.equal(requests.length, 0);
});

test("HTTP failures are returned without changing providers", async (t) => {
  anonymous(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests += 1;
    assert.equal(String(url), "https://search.parallel.ai/mcp");
    return new Response("Unavailable", { status: 503 });
  });
  const result = await execute("researchWeb", { query: "current NASA news" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /Unavailable/);
  assert.equal(requests, 1);
});

test("deadline also bounds MCP initialization", async (t) => {
  anonymous(t);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 45_000);
    return deadline.signal;
  });
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    queueMicrotask(() => deadline.abort(new DOMException("Timed out", "TimeoutError")));
  }));
  const result = await execute("researchWeb", { query: "current NASA news" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /timed out/);
});

test("already cancelled calls make no HTTP requests", async (t) => {
  anonymous(t);
  const requests = mcpServer(t);
  const reason = new Error("user cancelled");
  await assert.rejects(execute("researchWeb", { query: "current NASA news" }, AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(requests.length, 0);
});

test("timeout aborts a pending tool HTTP request", async (t) => {
  anonymous(t);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 45_000);
    return deadline.signal;
  });
  let aborted = false;
  mcpServer(t, (_rpc, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    queueMicrotask(() => deadline.abort(new DOMException("Timed out", "TimeoutError")));
  }));
  const result = await execute("webSearch", { query: "current NASA news" });
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.summary, /timed out/);
});

test("caller cancellation propagates and aborts the HTTP request", async (t) => {
  anonymous(t);
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  mcpServer(t, (_rpc, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    controller.abort(reason);
  }));
  await assert.rejects(execute("researchWeb", { query: "current NASA news" }, controller.signal), (error) => error === reason);
});
