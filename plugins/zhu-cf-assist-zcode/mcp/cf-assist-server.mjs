#!/usr/bin/env node
// zhu-cf-assist stdio MCP server（零依赖）。
// 协议面照 example-plugin 的 hello-server.mjs：换行分隔 JSON-RPC（不是 LSP Content-Length 帧），
// 只实现 initialize / ping / tools/list / tools/call。工具逻辑全部在 ./bridge.mjs。
//
// 手工冒烟（一行一请求；Git Bash 下执行）：
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cf_assist_guide","arguments":{}}}' \
//     | node mcp/cf-assist-server.mjs
import { createInterface } from "node:readline";
import { registerTools } from "./bridge.mjs";

const SERVER_INFO = {
  name: "zhu-cf-assist",
  version: "0.1.0",
};

const tools = new Map();
registerTools(def => tools.set(def.name, def));

const TOOL_LIST = [...tools.values()].map(({ name, description, inputSchema }) => ({
  name, description, inputSchema,
}));

function writeMessage(message) {
  // One JSON-RPC message per line — what MCP stdio clients expect.
  process.stdout.write(JSON.stringify(message) + "\n");
}

function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — ignore.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOL_LIST });
      return;
    case "tools/call": {
      if (shuttingDown) {
        fail(id, -32000, "server 正在关闭(stdin已结束)，本次调用未执行；请重连后重试");
        return;
      }
      const name = params?.name;
      const tool = tools.get(name);
      if (!tool) {
        fail(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      trackInFlight((async () => {
        try {
          const text = await tool.execute(params?.arguments || {});
          ok(id, { content: [{ type: "text", text: String(text) }], isError: false });
        } catch (err) {
          ok(id, {
            content: [{ type: "text", text: `ERROR: ${err?.message || err}` }],
            isError: true,
          });
        }
      })());
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });

// 优雅退出（修复方案步骤6）：stdin EOF 时不再立即 exit(0)——那会杀掉在途调用
// （cf_assist_test 内部要等启动器 1.5s，0926 23:08 的「零应答静默被杀」即此形态）。
// close 时先置关闭态：新调用直接回明确错误；在途调用给 5s grace 期，全部落定后（或到期）才退出。
let shuttingDown = false;
const inFlight = new Set();

function trackInFlight(p) {
  inFlight.add(p);
  p.then(() => inFlight.delete(p), () => inFlight.delete(p));
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (Array.isArray(msg)) {
      for (const item of msg) handleRequest(item);
    } else {
      handleRequest(msg);
    }
  } catch (err) {
    process.stderr.write(`[zhu-cf-assist] bad JSON: ${err}\n`);
  }
});
rl.on("close", () => {
  shuttingDown = true;
  const exitNow = () => process.exit(0);
  const grace = setTimeout(exitNow, 5000);
  Promise.allSettled([...inFlight]).then(() => { clearTimeout(grace); exitNow(); });
});

process.stderr.write("[zhu-cf-assist] stdio MCP server ready\n");
