import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server.js";

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-server-"));
  const server = createApp({ dataFile: join(directory, "state.json") }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("preview and local API are available", async () => {
  await fixture(async (base) => {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.version, "0.9.3");

    const html = await fetch(`${base}/preview`).then((response) => response.text());
    assert.match(html, /流程记忆/);
    assert.match(html, /requestClose/);
    assert.match(html, /撤销上次修改/);
    assert.match(html, /对话依据/);
    assert.match(html, /整理视图只改变展示/);
    assert.match(html, />复原</);
    assert.match(html, /相关文件/);

    const stateResponse = await fetch(`${base}/api/state?session=memory-graph`).then((response) => response.json());
    assert.equal(stateResponse.state.title, "记忆图谱插件");
    assert.equal(stateResponse.state.steps.length, 3);

    const projectA = await fetch(`${base}/api/state?session=project-a`).then((response) => response.json());
    assert.equal(projectA.state.title, "识别 PDF 并录入 Excel");
    assert.equal(projectA.state.steps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");

    const catalog = await fetch(`${base}/api/catalog?session=project-c`).then((response) => response.json());
    assert.equal(catalog.projects.find((project) => project.id === "project-a").artifacts[0].id, "master-excel");

    const lineage = await fetch(`${base}/api/lineage?session=project-c&artifactId=source-master-excel`).then((response) => response.json());
    assert.equal(lineage.lineage.sourceProject.id, "project-a");
    assert.match(lineage.lineage.sourceRules.join(" "), /金额列不得写成文本/);

    const utilityResponse = await fetch(`${base}/api/state?session=utility-bills`).then((response) => response.json());
    assert.equal(utilityResponse.state.title, "水电费整理");
    assert.equal(utilityResponse.state.steps[0].title, "收集账单");
    assert.equal(utilityResponse.state.steps.find((step) => step.id === "check-month").parentId, "verify-bills");
    assert.deepEqual(utilityResponse.state.steps.find((step) => step.id === "check-month").notes, ["跨月账单需要单独标记"]);
    assert.equal(utilityResponse.state.steps.find((step) => step.id === "save-ledger").conversationRefs.length, 2);

    const toggled = await fetch(`${base}/api/recording?session=memory-graph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }).then((response) => response.json());
    assert.equal(toggled.state.recording, false);
    assert.equal(toggled.state.canUndo, true);

    const undone = await fetch(`${base}/api/undo?session=memory-graph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }).then((response) => response.json());
    assert.equal(undone.state.recording, true);

    const moved = await fetch(`${base}/api/steps/extract-amount/move?session=project-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: "write-excel", afterId: "write-excel" })
    }).then((response) => response.json());
    assert.equal(moved.state.steps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");
    assert.equal(moved.state.displaySteps.find((step) => step.id === "extract-amount").parentId, "write-excel");
    assert.equal(moved.state.canUndo, true);

    const reordered = await fetch(`${base}/api/steps/write-excel/move?session=project-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: null, beforeId: "recognize-pdf" })
    }).then((response) => response.json());
    const mainSteps = reordered.state.displaySteps.filter((step) => !step.parentId);
    assert.equal(mainSteps[0].id, "write-excel");
    assert.equal(reordered.state.steps.filter((step) => !step.parentId)[0].id, "recognize-pdf");

    const restoredLayout = await fetch(`${base}/api/layout/restore?session=project-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }).then((response) => response.json());
    assert.equal(restoredLayout.state.displaySteps.filter((step) => !step.parentId)[0].id, "recognize-pdf");

    const grouped = await fetch(`${base}/api/steps/extract-amount/group?session=project-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ beforeId: "write-excel" })
    }).then((response) => response.json());
    const groupedChild = grouped.state.displaySteps.find((step) => step.id === "extract-amount");
    const groupedParent = grouped.state.displaySteps.find((step) => step.id === groupedChild.parentId);
    assert.ok(groupedParent?.virtual);
    assert.deepEqual(grouped.state.displaySteps.filter((step) => !step.parentId).map((step) => step.id), ["recognize-pdf", groupedParent.id, "write-excel"]);
    assert.equal(grouped.state.steps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");

    const utilityAfterToggle = await fetch(`${base}/api/state?session=utility-bills`).then((response) => response.json());
    assert.equal(utilityAfterToggle.state.recording, true);
  });
});

test("MCP exposes workflow tools and thread panel metadata", async () => {
  await fixture(async (base) => {
    const client = new Client({ name: "flow-memory-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const openTool = tools.tools.find((tool) => tool.name === "open_flow_memory");
      assert.ok(openTool);
      assert.deepEqual(openTool._meta?.["openai/ui"]?.entrypoints, [{ type: "thread" }]);
      assert.ok(tools.tools.find((tool) => tool.name === "sync_flow_snapshot"));
      assert.ok(tools.tools.find((tool) => tool.name === "list_project_summaries"));
      assert.ok(tools.tools.find((tool) => tool.name === "link_project_artifact"));
      assert.ok(tools.tools.find((tool) => tool.name === "trace_artifact_source"));
      assert.ok(tools.tools.find((tool) => tool.name === "delete_flow_step"));
      assert.ok(tools.tools.find((tool) => tool.name === "undo_last_flow_change"));
      assert.ok(tools.tools.find((tool) => tool.name === "move_flow_step"));
      assert.ok(tools.tools.find((tool) => tool.name === "restore_original_flow_layout"));
      assert.ok(tools.tools.find((tool) => tool.name === "group_flow_step"));
      assert.ok(tools.tools.find((tool) => tool.name === "rename_flow_group"));
      assert.ok(tools.tools.find((tool) => tool.name === "attach_flow_file"));
      assert.ok(tools.tools.find((tool) => tool.name === "open_flow_file"));
      assert.ok(tools.tools.find((tool) => tool.name === "remove_flow_file"));

      const result = await client.callTool({ name: "get_flow_state", arguments: {} });
      assert.equal(result.structuredContent.state.steps.length, 1);
    } finally {
      await client.close();
    }
  });
});
