import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewState, FlowStore } from "../lib/store.js";

test("FlowStore attaches, opens and removes a useful document without moving it", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const file = join(directory, "state.json");
    const document = join(directory, "识别结果总表.xlsx");
    writeFileSync(document, "demo", "utf8");
    const store = new FlowStore(file);
    store.put("project-a", createPreviewState("project-a"));
    const attached = store.attachFile("project-a", { path: document, stepId: "write-excel", role: "output" });
    const artifact = attached.artifacts.find((item) => item.path === document);
    assert.ok(artifact);
    assert.equal(artifact.createdByStepId, "write-excel");
    assert.equal(artifact.fileAvailable, true);

    let opened = "";
    store.openFile("project-a", artifact.id, (path) => { opened = path; });
    assert.equal(opened, document);

    const removed = store.removeFile("project-a", artifact.id);
    assert.equal(removed.artifacts.some((item) => item.id === artifact.id), false);
    assert.equal(existsSync(document), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore rejects backup and source-code file attachments", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    const backup = join(directory, "台账.备份.xlsx");
    const source = join(directory, "plugin.js");
    writeFileSync(backup, "demo", "utf8");
    writeFileSync(source, "demo", "utf8");
    assert.throws(() => store.attachFile("test", { path: backup }), /只支持/);
    assert.throws(() => store.attachFile("test", { path: source }), /只支持/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore persists recording and step updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const file = join(directory, "state.json");
    const store = new FlowStore(file);
    const original = store.get("conversation-a");
    assert.equal(original.steps.length, 1);
    assert.equal(original.recording, true);

    store.setRecording("conversation-a", false);
    const withStep = store.addStep("conversation-a", {
      title: "保存交付物",
      summary: "记录文件位置和版本。",
      status: "active",
      kind: "output"
    });
    const added = withStep.steps.at(-1);
    store.updateStep("conversation-a", { id: added.id, status: "done" });

    const reloaded = new FlowStore(file).get("conversation-a");
    assert.equal(reloaded.recording, false);
    assert.equal(reloaded.steps.at(-1).title, "保存交付物");
    assert.equal(reloaded.steps.at(-1).status, "done");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore inserts a new step after the requested step", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    const state = store.addStep("conversation-b", {
      title: "确认范围",
      afterId: "conversation-intake"
    });
    assert.equal(state.steps[1].title, "确认范围");
    assert.equal(state.steps[1].status, "pending");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore keeps different conversations isolated", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.syncFlow("memory-chat", {
      title: "记忆图谱",
      project: "插件开发",
      steps: [{ title: "制作面板", status: "active", kind: "output" }]
    });
    store.syncFlow("utility-chat", {
      title: "水电费",
      project: "家庭账单",
      steps: [{ title: "核对月份", status: "pending", kind: "checkpoint" }]
    });
    store.setRecording("memory-chat", false);

    assert.equal(store.get("memory-chat").title, "记忆图谱");
    assert.equal(store.get("memory-chat").recording, false);
    assert.equal(store.get("utility-chat").title, "水电费");
    assert.equal(store.get("utility-chat").recording, true);
    assert.equal(store.get("utility-chat").steps[0].title, "核对月份");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore preserves main steps, substeps and notes", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    const state = store.syncFlow("hierarchy-chat", {
      title: "识别并录入",
      steps: [
        { id: "recognize", title: "识别 PDF", status: "active", kind: "major", notes: ["保留原文件名"] },
        { id: "amount", parentId: "recognize", title: "提取金额", status: "pending", kind: "substep", notes: ["金额保留两位小数"] }
      ]
    });
    assert.equal(state.steps[1].parentId, "recognize");
    assert.deepEqual(state.steps[1].notes, ["金额保留两位小数"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore preserves short conversation references on a step", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    const state = store.syncFlow("reference-chat", {
      title: "费用台账",
      steps: [{
        id: "save-ledger",
        title: "写入费用台账",
        status: "pending",
        conversationRefs: [
          { role: "user", label: "记录要求", excerpt: "按月保存水费和电费。" },
          { role: "assistant", excerpt: "金额列使用数字格式。" }
        ]
      }]
    });
    assert.equal(state.steps[0].conversationRefs.length, 2);
    assert.equal(state.steps[0].conversationRefs[0].label, "记录要求");
    assert.equal(state.steps[0].conversationRefs[1].label, "AI 回复");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore undo is isolated by conversation and history is hidden from projects", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    store.put("project-b", createPreviewState("project-b"));
    const changed = store.updateStep("project-a", { id: "write-excel", title: "错误名称" });
    assert.equal(changed.canUndo, true);
    assert.equal(changed.steps.find((step) => step.id === "write-excel").title, "错误名称");

    const restored = store.undo("project-a");
    assert.equal(restored.steps.find((step) => step.id === "write-excel").title, "录入 Excel");
    assert.equal(store.get("project-b").title, "下载 PDF");
    assert.equal(store.list().some((project) => project.id === "__history"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore moves a substep only in the organized view and can undo it", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    const moved = store.moveStep("project-a", {
      id: "extract-amount",
      parentId: "write-excel",
      afterId: "write-excel"
    });
    assert.equal(moved.steps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");
    assert.equal(moved.displaySteps.find((step) => step.id === "extract-amount").parentId, "write-excel");
    assert.equal(moved.displaySteps.findIndex((step) => step.id === "extract-amount"), moved.displaySteps.findIndex((step) => step.id === "write-excel") + 1);

    const restored = store.undo("project-a");
    assert.equal(restored.displaySteps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore reorders main steps without changing the original flow", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    const moved = store.moveStep("project-a", {
      id: "write-excel",
      parentId: null,
      beforeId: "recognize-pdf"
    });
    assert.deepEqual(moved.steps.filter((step) => !step.parentId).map((step) => step.id), ["recognize-pdf", "write-excel"]);
    assert.deepEqual(moved.displaySteps.filter((step) => !step.parentId).map((step) => step.id), ["write-excel", "recognize-pdf"]);
    const restored = store.restoreOriginalLayout("project-a");
    assert.deepEqual(restored.displaySteps.filter((step) => !step.parentId).map((step) => step.id), ["recognize-pdf", "write-excel"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore supports repeated undo all the way to the first saved state", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    store.updateStep("project-a", { id: "write-excel", title: "第二次名称" });
    store.updateStep("project-a", { id: "write-excel", title: "第三次名称" });
    assert.equal(store.undo("project-a").steps.find((step) => step.id === "write-excel").title, "第二次名称");
    const initial = store.undo("project-a");
    assert.equal(initial.steps.find((step) => step.id === "write-excel").title, "录入 Excel");
    assert.equal(initial.canUndo, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore creates a new organized main group without promoting the original substep", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    const grouped = store.groupStep("project-a", { id: "extract-amount", beforeId: "write-excel" });
    const original = grouped.steps.find((step) => step.id === "extract-amount");
    const displayed = grouped.displaySteps.find((step) => step.id === "extract-amount");
    const group = grouped.displaySteps.find((step) => step.id === displayed.parentId);
    assert.equal(original.parentId, "recognize-pdf");
    assert.equal(group.virtual, true);
    assert.equal(group.title, "金额与日期处理");
    assert.deepEqual(grouped.displaySteps.filter((step) => !step.parentId).map((step) => step.id), ["recognize-pdf", group.id, "write-excel"]);

    const renamed = store.renameLayoutGroup("project-a", { id: group.id, title: "金额信息整理" });
    assert.equal(renamed.displaySteps.find((step) => step.id === group.id).title, "金额信息整理");

    const movedAway = store.moveStep("project-a", { id: "extract-amount", parentId: "write-excel", afterId: "write-excel" });
    assert.equal(movedAway.displaySteps.some((step) => step.id === group.id), false);
    assert.equal(movedAway.layout.groups.some((item) => item.id === group.id), false);

    const restored = store.restoreOriginalLayout("project-a");
    assert.equal(restored.displaySteps.some((step) => step.virtual), false);
    assert.equal(restored.displaySteps.find((step) => step.id === "extract-amount").parentId, "recognize-pdf");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore links an output and traces its source rules", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    store.put("project-c", createPreviewState("memory-graph"));
    const linked = store.linkArtifact("project-c", { sourceSessionId: "project-a", sourceArtifactId: "master-excel" });
    const input = linked.artifacts.find((item) => item.role === "input");
    assert.ok(input);
    assert.equal(linked.dependencies[0].confirmed, true);

    const lineage = store.traceLineage("project-c", input.id);
    assert.equal(lineage.sourceProject.title, "识别 PDF 并录入 Excel");
    assert.equal(lineage.sourceArtifact.name, "识别结果总表.xlsx");
    assert.match(lineage.sourceRules.join(" "), /金额列不得写成文本/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FlowStore deletes a main step without losing its child steps", () => {
  const directory = mkdtempSync(join(tmpdir(), "flow-memory-store-"));
  try {
    const store = new FlowStore(join(directory, "state.json"));
    store.put("project-a", createPreviewState("project-a"));
    const state = store.deleteStep("project-a", "recognize-pdf");
    assert.equal(state.steps.some((step) => step.id === "recognize-pdf"), false);
    assert.equal(state.steps.find((step) => step.id === "extract-amount").parentId, null);
    assert.equal(state.steps.find((step) => step.id === "extract-amount").kind, "major");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
