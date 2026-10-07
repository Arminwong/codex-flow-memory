import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { createPreviewState, FlowStore } from "./lib/store.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PANEL_URI = "ui://flow-memory/panel-v1.html";
const DEFAULT_DATA_FILE = join(
  process.env.PLUGIN_DATA ?? process.env.CODEX_PLUGIN_DATA ?? ROOT,
  "data",
  "state.json"
);
const PANEL_HTML = readFileSync(join(ROOT, "public", "panel.html"), "utf8");

function sessionId(extra) {
  return extra?._meta?.["openai/session"] ?? "local-mcp";
}

function previewSession(req) {
  const raw = String(req.query?.session ?? req.get?.("x-flow-session") ?? "memory-graph");
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160) || "memory-graph";
}

function response(state, message) {
  return {
    structuredContent: { state },
    content: [{ type: "text", text: message }],
    _meta: { state }
  };
}

function defaultOpenFile(filePath) {
  let child;
  if (process.platform === "win32") {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Invoke-Item -LiteralPath $env:FLOW_MEMORY_FILE"], {
      env: { ...process.env, FLOW_MEMORY_FILE: filePath },
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [filePath], { detached: true, stdio: "ignore" });
  }
  child.unref();
}

function buildMcpServer(store, openFile = defaultOpenFile) {
  const server = new McpServer(
    { name: "flow-memory", version: "0.9.3" },
    {
      instructions: "流程数据按当前对话隔离。用主步骤、次级步骤和注意事项记录层级；重要步骤可保存少量 conversationRefs 对话摘录作为依据，但不要复制整段对话或敏感信息。生成 PDF、Office、表格、Markdown 或文本成品后，用 attach_flow_file 把原始绝对路径关联到对应步骤；不要关联源码、插件、临时或备份文件，也不要移动或复制原文件。用产出物连接不同项目。关联必须由用户确认，异常时可回溯来源项目的规则和步骤。用户手动调整后以用户版本为准，必要时可还原上次修改。"
    }
  );

  registerAppResource(
    server,
    "流程记忆面板",
    PANEL_URI,
    { description: "在对话右侧展示当前流程、进度和复盘操作。" },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: PANEL_HTML,
          _meta: {
            ui: { prefersBorder: false },
            "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] }
          }
        }
      ]
    })
  );

  const panelMeta = {
    ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] },
    "openai/ui": { entrypoints: [{ type: "thread" }] }
  };

  registerAppTool(
    server,
    "open_flow_memory",
    {
      title: "打开流程记忆",
      description: "打开当前对话的流程记忆侧面板，并返回当前流程状态。",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: panelMeta
    },
    async (extra) => response(store.get(sessionId(extra)), "已打开流程记忆面板。")
  );

  registerAppTool(
    server,
    "sync_flow_snapshot",
    {
      title: "同步当前对话流程",
      description: "根据当前对话同步一份完整流程快照。只影响当前对话，不会读取或覆盖其他对话的图谱。适合首次建立图谱或流程结构发生明显变化时使用。",
      inputSchema: {
        title: z.string().min(1).max(120).describe("当前对话流程的简短标题"),
        project: z.string().min(1).max(120).optional().describe("项目或对话主题"),
        recording: z.boolean().optional(),
        steps: z.array(z.object({
          id: z.string().max(120).optional(),
          parentId: z.string().max(120).nullable().optional(),
          title: z.string().min(1).max(120),
          summary: z.string().max(500).optional(),
          status: z.enum(["done", "active", "pending", "blocked"]),
          kind: z.string().max(40).optional(),
          notes: z.array(z.string().max(240)).max(8).optional(),
          conversationRefs: z.array(z.object({
            role: z.enum(["user", "assistant"]),
            label: z.string().max(80).optional(),
            excerpt: z.string().min(1).max(500)
          })).max(6).optional()
        })).min(1).max(80),
        artifacts: z.array(z.object({
          id: z.string().max(120).optional(),
          name: z.string().min(1).max(160),
          role: z.enum(["input", "output"]),
          status: z.string().max(40).optional(),
          createdByStepId: z.string().max(120).nullable().optional(),
          path: z.string().max(2048).optional().describe("原始文件的绝对路径；只记录路径，不移动或复制文件"),
          format: z.string().max(240).optional(),
          rules: z.array(z.string().max(240)).max(12).optional()
        })).max(40).optional(),
        issues: z.array(z.object({
          id: z.string().max(120).optional(),
          title: z.string().min(1).max(160),
          summary: z.string().max(500).optional(),
          status: z.string().max(40).optional(),
          artifactId: z.string().max(120).nullable().optional(),
          stepId: z.string().max(120).nullable().optional()
        })).max(40).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.syncFlow(sessionId(extra), input), `已同步当前对话流程：${input.title}`)
  );

  registerAppTool(
    server,
    "get_flow_state",
    {
      title: "读取流程状态",
      description: "读取当前对话的流程步骤、记录状态和进度。",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (extra) => response(store.get(sessionId(extra)), "已读取当前流程。")
  );

  registerAppTool(
    server,
    "set_flow_recording",
    {
      title: "切换流程记录",
      description: "开启或暂停当前对话的流程记录。",
      inputSchema: { enabled: z.boolean().describe("是否开启记录") },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async ({ enabled }, extra) => {
      const state = store.setRecording(sessionId(extra), enabled);
      return response(state, enabled ? "流程记录已开启。" : "流程记录已暂停。");
    }
  );

  registerAppTool(
    server,
    "add_flow_step",
    {
      title: "添加流程步骤",
      description: "将已确认的重要动作、检查点或交付物添加到当前流程。",
      inputSchema: {
        title: z.string().min(1).max(120),
        summary: z.string().max(500).optional(),
        status: z.enum(["done", "active", "pending", "blocked"]).optional(),
        kind: z.string().max(40).optional(),
        parentId: z.string().max(120).nullable().optional(),
        notes: z.array(z.string().max(240)).max(8).optional(),
        conversationRefs: z.array(z.object({ role: z.enum(["user", "assistant"]), label: z.string().max(80).optional(), excerpt: z.string().min(1).max(500) })).max(6).optional(),
        afterId: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.addStep(sessionId(extra), input), `已记录步骤：${input.title}`)
  );

  registerAppTool(
    server,
    "update_flow_step",
    {
      title: "更新流程步骤",
      description: "更新某个流程步骤的状态或说明。",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().max(120).optional(),
        summary: z.string().max(500).optional(),
        status: z.enum(["done", "active", "pending", "blocked"]).optional(),
        kind: z.string().max(40).optional(),
        parentId: z.string().max(120).nullable().optional(),
        notes: z.array(z.string().max(240)).max(8).optional(),
        conversationRefs: z.array(z.object({ role: z.enum(["user", "assistant"]), label: z.string().max(80).optional(), excerpt: z.string().min(1).max(500) })).max(6).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.updateStep(sessionId(extra), input), "流程步骤已更新。")
  );

  registerAppTool(
    server,
    "attach_flow_file",
    {
      title: "添加相关文件",
      description: "把已生成的 PDF、Office、表格、Markdown 或文本成品文件关联到相应流程步骤。只保存原始绝对路径，不移动或复制文件；不要添加源码、插件文件、临时文件或备份文件。",
      inputSchema: {
        path: z.string().min(1).max(2048).describe("现有成品文件的绝对路径"),
        stepId: z.string().min(1).max(120).nullable().optional().describe("生成或使用该文件的流程步骤"),
        name: z.string().max(160).optional(),
        role: z.enum(["input", "output"]).optional(),
        format: z.string().max(240).optional(),
        rules: z.array(z.string().max(240)).max(12).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.attachFile(sessionId(extra), input), `已关联原始文件：${input.name || input.path}`)
  );

  registerAppTool(
    server,
    "open_flow_file",
    {
      title: "打开相关文件",
      description: "用电脑的默认程序打开流程中记录的原始文件，不改变文件位置。",
      inputSchema: { artifactId: z.string().min(1).max(120) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async ({ artifactId }, extra) => {
      const artifact = store.openFile(sessionId(extra), artifactId, openFile);
      return { structuredContent: { opened: artifact }, content: [{ type: "text", text: `已打开：${artifact.name}` }] };
    }
  );

  registerAppTool(
    server,
    "remove_flow_file",
    {
      title: "移除相关文件",
      description: "只从当前流程的相关文件列表移除记录，不删除电脑上的原始文件。",
      inputSchema: { artifactId: z.string().min(1).max(120) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async ({ artifactId }, extra) => response(store.removeFile(sessionId(extra), artifactId), "已从流程中移除文件记录，原始文件没有删除。")
  );

  registerAppTool(
    server,
    "list_project_summaries",
    {
      title: "列出可关联项目",
      description: "列出用户已有项目及其产出物，供用户选择关联。不会自动建立关联。",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (extra) => ({
      structuredContent: { projects: store.list(sessionId(extra)) },
      content: [{ type: "text", text: "已列出可关联的项目和产出物。" }]
    })
  );

  registerAppTool(
    server,
    "delete_flow_step",
    {
      title: "删除流程步骤",
      description: "删除用户明确选择的流程步骤；如果删除主步骤，其次级步骤会提升为主步骤，避免内容一起丢失。",
      inputSchema: { id: z.string().min(1).max(120) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async ({ id }, extra) => response(store.deleteStep(sessionId(extra), id), "流程步骤已删除。")
  );

  registerAppTool(
    server,
    "move_flow_step",
    {
      title: "移动流程步骤",
      description: "只调整整理视图里的步骤顺序或主次归属，不修改原始流程底稿。只允许主步骤和次级步骤两层结构。",
      inputSchema: {
        id: z.string().min(1).max(120),
        parentId: z.string().max(120).nullable(),
        afterId: z.string().max(120).nullable().optional(),
        beforeId: z.string().max(120).nullable().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async (input, extra) => response(store.moveStep(sessionId(extra), input), "流程步骤已移动。")
  );

  registerAppTool(
    server,
    "restore_original_flow_layout",
    {
      title: "恢复原始流程顺序",
      description: "清除当前对话的整理视图排序，恢复原始流程底稿的顺序与层级；不会删除步骤内容。",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async (extra) => response(store.restoreOriginalLayout(sessionId(extra)), "整理视图已恢复为原始流程顺序。")
  );

  registerAppTool(
    server,
    "group_flow_step",
    {
      title: "为次级步骤新建主步骤",
      description: "在整理视图中创建一个新的主步骤，并把指定次级步骤放入其中；原始流程底稿和该步骤的次级身份不变。",
      inputSchema: {
        id: z.string().min(1).max(120),
        title: z.string().max(120).optional(),
        beforeId: z.string().max(120).optional(),
        afterId: z.string().max(120).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.groupStep(sessionId(extra), input), "已在整理视图中建立新的主步骤分组。")
  );

  registerAppTool(
    server,
    "rename_flow_group",
    {
      title: "命名整理视图分组",
      description: "为整理视图中的自动主步骤分组设置简短准确的名称，不修改原始流程。",
      inputSchema: { id: z.string().min(1).max(120), title: z.string().min(1).max(120) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.renameLayoutGroup(sessionId(extra), input), "整理视图分组已重新命名。")
  );

  registerAppTool(
    server,
    "undo_last_flow_change",
    {
      title: "还原上次流程修改",
      description: "将当前对话的流程图谱恢复到上一次修改前的快照。",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async (extra) => response(store.undo(sessionId(extra)), "已还原到上一次修改前。")
  );

  registerAppTool(
    server,
    "link_project_artifact",
    {
      title: "确认关联项目产出物",
      description: "在用户明确确认后，把另一个项目的产出物作为当前项目的输入。",
      inputSchema: {
        sourceSessionId: z.string().min(1).max(160),
        sourceArtifactId: z.string().min(1).max(120)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async (input, extra) => response(store.linkArtifact(sessionId(extra), input), "已确认关联来源项目。")
  );

  registerAppTool(
    server,
    "trace_artifact_source",
    {
      title: "回溯文件来源",
      description: "回溯当前项目某个输入文件的来源项目、生成步骤和格式规则，用于诊断异常。",
      inputSchema: { artifactId: z.string().min(1).max(120) },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["model", "app"] } }
    },
    async ({ artifactId }, extra) => {
      const lineage = store.traceLineage(sessionId(extra), artifactId);
      return {
        structuredContent: { lineage },
        content: [{ type: "text", text: `已回溯到来源项目：${lineage.sourceProject.title}` }]
      };
    }
  );

  registerAppTool(
    server,
    "reset_flow_demo",
    {
      title: "重置演示流程",
      description: "将当前对话恢复为第一版演示流程。",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } }
    },
    async (extra) => response(store.reset(sessionId(extra)), "演示流程已重置。")
  );

  return server;
}

export function createApp(options = {}) {
  const dataFile = options.dataFile ?? process.env.FLOW_MEMORY_DATA ?? DEFAULT_DATA_FILE;
  const store = new FlowStore(dataFile);
  const openFile = options.openFile ?? defaultOpenFile;
  if (options.seedPreview !== false) {
    for (const id of ["memory-graph", "utility-bills", "project-a", "project-b", "project-c"]) {
      if (!store.has(id)) store.put(id, createPreviewState(id));
    }
  }
  const app = createMcpExpressApp();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "flow-memory", version: "0.9.3", scope: "per-conversation" });
  });

  app.get(["/", "/preview"], (_req, res) => {
    res.type("html").send(PANEL_HTML);
  });

  app.get("/api/sessions", (_req, res) => res.json({ sessions: store.list() }));
  app.get("/api/catalog", (req, res) => res.json({ projects: store.list(previewSession(req)) }));
  app.get("/api/state", (req, res) => res.json({ state: store.get(previewSession(req)) }));
  app.post("/api/recording", (req, res) => {
    res.json({ state: store.setRecording(previewSession(req), req.body?.enabled) });
  });
  app.post("/api/steps", (req, res) => {
    res.json({ state: store.addStep(previewSession(req), req.body ?? {}) });
  });
  app.post("/api/files", (req, res) => {
    try {
      res.json({ state: store.attachFile(previewSession(req), req.body ?? {}) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/api/files/:id/open", (req, res) => {
    try {
      res.json({ opened: store.openFile(previewSession(req), req.params.id, openFile) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.delete("/api/files/:id", (req, res) => {
    try {
      res.json({ state: store.removeFile(previewSession(req), req.params.id) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.patch("/api/steps/:id", (req, res) => {
    try {
      res.json({ state: store.updateStep(previewSession(req), { ...req.body, id: req.params.id }) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.post("/api/steps/:id/move", (req, res) => {
    try {
      res.json({ state: store.moveStep(previewSession(req), { ...req.body, id: req.params.id }) });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });
  app.delete("/api/steps/:id", (req, res) => {
    try {
      res.json({ state: store.deleteStep(previewSession(req), req.params.id) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.post("/api/undo", (req, res) => {
    try {
      res.json({ state: store.undo(previewSession(req)) });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });
  app.post("/api/layout/restore", (req, res) => {
    res.json({ state: store.restoreOriginalLayout(previewSession(req)) });
  });
  app.post("/api/steps/:id/group", (req, res) => {
    try {
      res.json({ state: store.groupStep(previewSession(req), { ...req.body, id: req.params.id }) });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });
  app.patch("/api/layout/groups/:id", (req, res) => {
    try {
      res.json({ state: store.renameLayoutGroup(previewSession(req), { ...req.body, id: req.params.id }) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.post("/api/link", (req, res) => {
    try {
      res.json({ state: store.linkArtifact(previewSession(req), req.body ?? {}) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.get("/api/lineage", (req, res) => {
    try {
      res.json({ lineage: store.traceLineage(previewSession(req), String(req.query?.artifactId ?? "")) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
  app.post("/api/reset", (req, res) => {
    const selected = previewSession(req);
    const previews = new Set(["memory-graph", "utility-bills", "project-a", "project-b", "project-c"]);
    const state = createPreviewState(previews.has(selected) ? selected : "memory-graph");
    res.json({ state: store.put(selected, state, { clearHistory: true }) });
  });

  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer(store, openFile);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return app;
}

export function startServer({ port = Number(process.env.PORT ?? 8787), dataFile } = {}) {
  const app = createApp({ dataFile });
  return app.listen(port, "127.0.0.1", () => {
    console.log(`Flow Memory listening on http://127.0.0.1:${port}`);
    console.log(`Preview: http://127.0.0.1:${port}/preview`);
    console.log(`MCP:     http://127.0.0.1:${port}/mcp`);
  });
}

export async function startStdio({ dataFile } = {}) {
  const resolvedDataFile = dataFile ?? process.env.FLOW_MEMORY_DATA ?? DEFAULT_DATA_FILE;
  const store = new FlowStore(resolvedDataFile);
  const server = buildMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--stdio")) {
    startStdio().catch((error) => {
      console.error("Flow Memory stdio server failed", error);
      process.exitCode = 1;
    });
  } else {
    startServer();
  }
}
