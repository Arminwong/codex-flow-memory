import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("stdio transport exposes and runs Flow Memory tools", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "flow-memory-stdio-"));
  const dataFile = join(temporary, "state.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.js", "--stdio"],
    cwd: ROOT,
    env: { ...process.env, FLOW_MEMORY_DATA: dataFile }
  });
  const client = new Client({ name: "flow-memory-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("open_flow_memory"));
    assert.ok(names.includes("set_flow_recording"));
    assert.ok(names.includes("sync_flow_snapshot"));

    const meta = { "openai/session": "stdio-test-session" };
    const recording = await client.callTool({
      name: "set_flow_recording",
      arguments: { enabled: true },
      _meta: meta
    });
    assert.equal(recording.isError, undefined, JSON.stringify(recording));
    const synced = await client.callTool({
      name: "sync_flow_snapshot",
      arguments: {
        title: "测试流程",
        project: "stdio 自动启动",
        steps: [
          { id: "verify", title: "验证自动启动", status: "active", kind: "major" }
        ]
      },
      _meta: meta
    });
    assert.equal(synced.isError, undefined, JSON.stringify(synced));
    assert.equal(synced.structuredContent.state.title, "测试流程");
    const opened = await client.callTool({
      name: "open_flow_memory",
      arguments: {},
      _meta: meta
    });
    assert.equal(opened.structuredContent.state.title, "测试流程");
    assert.equal(opened.structuredContent.state.recording, true);
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
