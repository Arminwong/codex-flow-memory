import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, normalize } from "node:path";
import { randomUUID } from "node:crypto";

const STATUS_VALUES = new Set(["done", "active", "pending", "blocked"]);
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".md", ".txt", ".rtf",
  ".doc", ".docx", ".odt",
  ".xls", ".xlsx", ".xlsm", ".csv", ".tsv", ".ods",
  ".ppt", ".pptx", ".odp"
]);

export function isUsefulDocumentPath(value) {
  const filePath = cleanText(value, "", 2048);
  if (!filePath || !isAbsolute(filePath)) return false;
  const fileName = basename(filePath).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extname(fileName))) return false;
  if (fileName.endsWith("~") || /\.(bak|backup|old|tmp)(\.|$)/i.test(fileName)) return false;
  if (/(^|[._ -])(backup|备份|副本|old|copy)([._ -]|$)/i.test(fileName)) return false;
  return true;
}

function checkedDocumentPath(value) {
  const filePath = normalize(cleanText(value, "", 2048));
  if (!isUsefulDocumentPath(filePath)) {
    throw new Error("只支持 PDF、Office、表格、Markdown 和文本等非备份成品文件");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("找不到这个文件，请确认它仍在原位置");
  return filePath;
}

function cleanText(value, fallback = "", limit = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, limit);
}

function cleanList(values, limit = 8) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((item) => cleanText(item, "", 240)).filter(Boolean);
}

function cleanConversationRefs(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 6).map((item) => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    label: cleanText(item?.label, item?.role === "assistant" ? "AI 回复" : "你的要求", 80),
    excerpt: cleanText(item?.excerpt, "", 500)
  })).filter((item) => item.excerpt);
}

function createLayout(steps) {
  return {
    order: steps.map((step) => step.id),
    parentById: Object.fromEntries(steps.map((step) => [step.id, step.parentId ?? null])),
    groups: []
  };
}

function normalizeLayout(value, steps) {
  const stepIds = new Set(steps.map((step) => step.id));
  const groups = Array.isArray(value?.groups) ? value.groups.slice(0, 100).map((group) => ({
    id: cleanText(group?.id, `group-${randomUUID()}`, 120),
    parentId: null,
    title: cleanText(group?.title, "新分组", 120),
    summary: cleanText(group?.summary, "整理视图中的自动分组。"),
    status: STATUS_VALUES.has(group?.status) ? group.status : "active",
    kind: "major",
    notes: cleanList(group?.notes),
    conversationRefs: [],
    virtual: true
  })).filter((group, index, all) => !stepIds.has(group.id) && all.findIndex((item) => item.id === group.id) === index) : [];
  const items = [...steps, ...groups];
  const ids = new Set(items.map((item) => item.id));
  const order = [];
  for (const id of Array.isArray(value?.order) ? value.order : []) {
    const cleaned = cleanText(id, "", 120);
    if (ids.has(cleaned) && !order.includes(cleaned)) order.push(cleaned);
  }
  for (const item of items) if (!order.includes(item.id)) order.push(item.id);

  const parentById = {};
  for (const item of items) {
    const requested = cleanText(value?.parentById?.[item.id], "", 120) || null;
    const fallback = item.virtual ? null : (item.parentId ?? null);
    parentById[item.id] = requested && requested !== item.id && ids.has(requested) ? requested : fallback;
  }
  for (const item of items) {
    const parentId = parentById[item.id];
    if (parentId && parentById[parentId]) parentById[item.id] = item.virtual ? null : (item.parentId ?? null);
  }
  const usedParents = new Set(Object.values(parentById).filter(Boolean));
  const retainedGroups = groups.filter((group) => usedParents.has(group.id));
  const removedGroupIds = new Set(groups.filter((group) => !usedParents.has(group.id)).map((group) => group.id));
  for (const id of removedGroupIds) delete parentById[id];
  return { order: order.filter((id) => !removedGroupIds.has(id)), parentById, groups: retainedGroups };
}

function applyLayout(steps, layout) {
  const byId = new Map([...steps, ...(layout.groups ?? [])].map((step) => [step.id, step]));
  return layout.order.map((id) => byId.get(id)).filter(Boolean).map((step) => ({
    ...step,
    parentId: layout.parentById[step.id] ?? null
  }));
}

function suggestGroupTitle(stepTitle) {
  const title = cleanText(stepTitle, "新步骤", 120);
  const subject = title.replace(/^(判断|核对|检查|提取|设置|映射|记录|保存|写入|下载|收集|计算|处理|生成|识别|确认|比较)/, "").trim();
  if (!subject || subject === title || /(处理|整理|管理|录入|生成)$/.test(title)) return `${title}阶段`.slice(0, 120);
  return `${subject}处理`.slice(0, 120);
}

function normalizeState(state) {
  const steps = Array.isArray(state.steps) ? state.steps.map((step) => ({
    id: cleanText(step.id, randomUUID(), 120),
    parentId: cleanText(step.parentId, "", 120) || null,
    title: cleanText(step.title, "未命名步骤", 120),
    summary: cleanText(step.summary, "等待补充说明"),
    status: STATUS_VALUES.has(step.status) ? step.status : "pending",
    kind: cleanText(step.kind, "required", 40),
    notes: cleanList(step.notes),
    conversationRefs: cleanConversationRefs(step.conversationRefs)
  })) : [];
  return {
    version: 4,
    title: cleanText(state.title, "等待识别当前对话", 120),
    project: cleanText(state.project, "当前对话", 120),
    recording: state.recording !== false,
    view: state.view === "all" ? "all" : "current",
    updatedAt: state.updatedAt ?? new Date().toISOString(),
    steps,
    layout: normalizeLayout(state.layout, steps),
    artifacts: Array.isArray(state.artifacts) ? state.artifacts.map((artifact) => ({
      id: cleanText(artifact.id, randomUUID(), 120),
      name: cleanText(artifact.name, "未命名文件", 160),
      role: artifact.role === "input" ? "input" : "output",
      status: cleanText(artifact.status, "ready", 40),
      createdByStepId: cleanText(artifact.createdByStepId, "", 120) || null,
      path: isUsefulDocumentPath(artifact.path) ? normalize(cleanText(artifact.path, "", 2048)) : "",
      format: cleanText(artifact.format, "", 240),
      rules: cleanList(artifact.rules, 12),
      source: artifact.source ? {
        sessionId: cleanText(artifact.source.sessionId, "", 160),
        artifactId: cleanText(artifact.source.artifactId, "", 120)
      } : null
    })) : [],
    dependencies: Array.isArray(state.dependencies) ? state.dependencies.map((dependency) => ({
      id: cleanText(dependency.id, randomUUID(), 120),
      type: "input-from",
      sourceSessionId: cleanText(dependency.sourceSessionId, "", 160),
      sourceArtifactId: cleanText(dependency.sourceArtifactId, "", 120),
      targetArtifactId: cleanText(dependency.targetArtifactId, "", 120),
      confirmed: dependency.confirmed !== false
    })) : [],
    issues: Array.isArray(state.issues) ? state.issues.map((issue) => ({
      id: cleanText(issue.id, randomUUID(), 120),
      title: cleanText(issue.title, "待处理异常", 160),
      summary: cleanText(issue.summary, "等待补充异常说明"),
      status: issue.status === "resolved" ? "resolved" : "open",
      artifactId: cleanText(issue.artifactId, "", 120) || null,
      stepId: cleanText(issue.stepId, "", 120) || null
    })) : []
  };
}

export function createDefaultState() {
  return normalizeState({
    title: "等待识别当前对话",
    project: "当前对话",
    recording: true,
    steps: [{
      id: "conversation-intake",
      title: "正在分析当前对话",
      summary: "识别目标、大步骤、次级步骤和注意事项后，这里会自动更新。",
      status: "active",
      kind: "system"
    }]
  });
}

export function createPreviewState(type) {
  const common = { recording: true, view: "current" };

  if (type === "project-a") {
    return normalizeState({
      ...common,
      title: "识别 PDF 并录入 Excel",
      project: "项目A",
      steps: [
        { id: "recognize-pdf", title: "识别 PDF", summary: "从不同类型的 PDF 中识别业务字段。", status: "active", kind: "major", notes: ["不同票据类型要记录对应模板", "原始金额和识别金额都要保留"] },
        { id: "detect-type", parentId: "recognize-pdf", title: "判断 PDF 类型", summary: "先判断发票、回单或其他文档类型。", status: "done", kind: "substep", notes: ["无法识别的类型进入人工确认"] },
        { id: "extract-amount", parentId: "recognize-pdf", title: "提取金额与日期", summary: "提取金额、日期、编号和交易方。", status: "active", kind: "substep", notes: ["金额必须保留两位小数", "注意千位分隔符和负数"] },
        { id: "verify-recognition", parentId: "recognize-pdf", title: "核对识别结果", summary: "抽查关键字段并记录置信度不足的项目。", status: "pending", kind: "checkpoint" },
        { id: "write-excel", title: "录入 Excel", summary: "按固定字段和格式写入总表。", status: "pending", kind: "major", notes: ["字段顺序和数据类型必须稳定"] },
        { id: "map-columns", parentId: "write-excel", title: "映射 Excel 字段", summary: "将识别字段映射到固定列。", status: "pending", kind: "substep", notes: ["缺失字段留空，不要错列"] },
        { id: "format-cells", parentId: "write-excel", title: "设置单元格格式", summary: "金额使用数字格式，日期使用统一格式。", status: "pending", kind: "substep", notes: ["不要把金额写成文本", "日期统一为 YYYY-MM-DD"] },
        { id: "validate-workbook", parentId: "write-excel", title: "检查输出总表", summary: "检查重复行、空值和数据类型。", status: "pending", kind: "checkpoint" }
      ],
      artifacts: [{
        id: "master-excel",
        name: "识别结果总表.xlsx",
        role: "output",
        status: "building",
        createdByStepId: "write-excel",
        format: "每份 PDF 一行；金额为数字；日期为 YYYY-MM-DD",
        rules: ["保留来源 PDF 文件名", "金额列不得写成文本", "无法识别的字段保留空值并标注"]
      }]
    });
  }

  if (type === "project-b") {
    return normalizeState({
      ...common,
      title: "下载 PDF",
      project: "项目B",
      steps: [
        { id: "collect-links", title: "收集下载地址", summary: "整理所有需要下载的 PDF 地址。", status: "done", kind: "major" },
        { id: "download-files", title: "批量下载 PDF", summary: "下载并按统一规则命名。", status: "active", kind: "major", notes: ["失败链接单独记录，避免静默遗漏"] },
        { id: "check-count", parentId: "download-files", title: "核对下载数量", summary: "对比链接数和实际文件数。", status: "pending", kind: "checkpoint" }
      ],
      artifacts: [{ id: "pdf-folder", name: "待识别PDF文件夹", role: "output", status: "building", format: "PDF 文件集合", rules: ["文件名保持唯一"] }]
    });
  }

  if (type === "project-c") {
    return normalizeState({
      ...common,
      title: "拆分 Excel 分表",
      project: "项目C",
      steps: [
        { id: "inspect-input", title: "检查输入总表", summary: "确认输入文件、字段和来源。", status: "done", kind: "major" },
        { id: "confirm-source", parentId: "inspect-input", title: "确认文件来源", summary: "已关联项目A的识别结果总表。", status: "done", kind: "substep" },
        { id: "diagnose-anomaly", title: "处理数据异常", summary: "金额列存在非数字值，正在判断异常产生环节。", status: "blocked", kind: "major", notes: ["先回溯项目A的识别和录入规则，再修改当前拆分逻辑"] },
        { id: "check-amount-column", parentId: "diagnose-anomaly", title: "检查金额列类型", summary: "发现部分金额带有货币符号或被写成文本。", status: "blocked", kind: "substep", notes: ["不要直接删除异常行"] },
        { id: "trace-origin", parentId: "diagnose-anomaly", title: "回溯来源项目", summary: "查看项目A如何识别金额并写入 Excel。", status: "active", kind: "checkpoint" },
        { id: "split-sheets", title: "生成多个分表", summary: "异常解决后，按指定字段拆分工作表。", status: "pending", kind: "major" },
        { id: "verify-sheets", parentId: "split-sheets", title: "核对分表结果", summary: "检查行数守恒、表头一致和文件命名。", status: "pending", kind: "checkpoint" }
      ],
      artifacts: [{ id: "source-master-excel", name: "识别结果总表.xlsx", role: "input", status: "linked", format: "来自项目A", source: { sessionId: "project-a", artifactId: "master-excel" } }],
      dependencies: [{ id: "project-a-to-c", sourceSessionId: "project-a", sourceArtifactId: "master-excel", targetArtifactId: "source-master-excel", confirmed: true }],
      issues: [{ id: "amount-type-error", title: "金额列存在非数字值", summary: "拆分前校验失败，需要确认问题来自 PDF 识别还是 Excel 录入格式。", status: "open", artifactId: "source-master-excel", stepId: "diagnose-anomaly" }]
    });
  }

  if (type === "utility-bills") {
    return normalizeState({
      ...common,
      title: "水电费整理",
      project: "对话：水电费",
      steps: [
        { id: "collect-bills", title: "收集账单", summary: "收齐本期水费、电费账单和上期记录。", status: "done", kind: "major" },
        { id: "collect-water", parentId: "collect-bills", title: "收集水费账单", summary: "确认水费账单图片或 PDF 已保存。", status: "done", kind: "substep", notes: ["保留账单原文件，方便以后核对"] },
        { id: "collect-power", parentId: "collect-bills", title: "收集电费账单", summary: "确认电费账单和户号信息齐全。", status: "done", kind: "substep", notes: ["多个户号不能混在同一条记录里"] },
        { id: "verify-bills", title: "核对账单", summary: "检查月份、户号、金额和缴费周期。", status: "active", kind: "major", notes: ["先核对月份，再计算用量"] },
        { id: "check-month", parentId: "verify-bills", title: "核对账单月份", summary: "确认水费、电费属于同一个统计周期。", status: "active", kind: "checkpoint", notes: ["跨月账单需要单独标记"] },
        { id: "check-account", parentId: "verify-bills", title: "核对户号与地址", summary: "确认账单属于正确的房屋和户号。", status: "pending", kind: "checkpoint", notes: ["户号一致不代表地址一定一致"] },
        { id: "calculate-usage", title: "计算并记录用量", summary: "与上期读数比较，计算并保存本期实际用量。", status: "pending", kind: "major" },
        { id: "compare-readings", parentId: "calculate-usage", title: "比较本期与上期读数", summary: "用本期读数减去上期读数。", status: "pending", kind: "substep", notes: ["出现负数时先检查换表或录入错误"] },
        { id: "save-ledger", parentId: "calculate-usage", title: "写入费用台账", summary: "记录月份、用量、金额和缴费状态。", status: "pending", kind: "substep", notes: ["金额列使用数字格式，不要带文字"], conversationRefs: [
          { role: "user", label: "提出记录要求", excerpt: "把每个月的水费和电费整理成台账，后面方便核对和计算用量。" },
          { role: "assistant", label: "确认台账字段", excerpt: "台账将记录月份、户号、用量、金额和缴费状态；金额列保持数字格式。" }
        ] }
      ]
    });
  }

  return normalizeState({
    ...common,
    title: "记忆图谱插件",
    project: "对话：记忆图谱",
    steps: [
      { id: "watch-examples", title: "查看参考视频", summary: "理解记忆图谱和右侧面板的目标效果。", status: "done", kind: "major" },
      { id: "build-panel", title: "制作流程面板", summary: "完成流程图、状态和对话隔离。", status: "done", kind: "major" },
      { id: "add-hierarchy", title: "增加层级与项目关联", summary: "展示大步骤、次级步骤、注意事项和文件来源。", status: "active", kind: "major" }
    ]
  });
}

export class FlowStore {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) this.#writeAll({});
  }

  #readAll() {
    try { return JSON.parse(readFileSync(this.filePath, "utf8")); } catch { return {}; }
  }

  #writeAll(data) {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }

  #decorate(state, all, sessionId) {
    const result = structuredClone(state);
    const depth = Array.isArray(all.__history?.[sessionId]) ? all.__history[sessionId].length : 0;
    result.displaySteps = applyLayout(result.steps, result.layout);
    result.canUndo = depth > 0;
    result.historyDepth = depth;
    result.artifacts = result.artifacts.map((artifact) => ({
      ...artifact,
      fileAvailable: Boolean(artifact.path && existsSync(artifact.path))
    }));
    return result;
  }

  #mutate(sessionId, mutator) {
    const all = this.#readAll();
    const state = normalizeState(all[sessionId] ?? createDefaultState());
    all.__history ??= {};
    all.__history[sessionId] ??= [];
    all.__history[sessionId].push(structuredClone(state));
    mutator(state, all);
    state.updatedAt = new Date().toISOString();
    all[sessionId] = normalizeState(state);
    this.#writeAll(all);
    return this.#decorate(all[sessionId], all, sessionId);
  }

  get(sessionId = "local-demo") {
    const all = this.#readAll();
    if (!all[sessionId]) {
      all[sessionId] = createDefaultState();
      this.#writeAll(all);
    } else if (all[sessionId].version !== 4) {
      all[sessionId] = normalizeState(all[sessionId]);
      this.#writeAll(all);
    }
    return this.#decorate(all[sessionId], all, sessionId);
  }

  has(sessionId) { return Boolean(this.#readAll()[sessionId]); }

  put(sessionId, state, options = {}) {
    const all = this.#readAll();
    all[sessionId] = normalizeState(state);
    all[sessionId].updatedAt = new Date().toISOString();
    if (options.clearHistory && all.__history) delete all.__history[sessionId];
    this.#writeAll(all);
    return this.#decorate(all[sessionId], all, sessionId);
  }

  list(currentSessionId = null) {
    const all = this.#readAll();
    return Object.entries(all).filter(([id]) => !id.startsWith("__")).map(([id, rawState]) => {
      const state = normalizeState(rawState);
      return {
        id,
        title: state.title,
        project: state.project,
        current: id === currentSessionId,
        recording: state.recording,
        updatedAt: state.updatedAt,
        stepCount: state.steps.length,
        artifacts: state.artifacts.filter((artifact) => artifact.role === "output").map((artifact) => ({ id: artifact.id, name: artifact.name, status: artifact.status, format: artifact.format }))
      };
    });
  }

  setRecording(sessionId, enabled) {
    return this.#mutate(sessionId, (state) => { state.recording = Boolean(enabled); });
  }

  addStep(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const step = {
        id: randomUUID(),
        parentId: cleanText(input.parentId, "", 120) || null,
        title: cleanText(input.title, "未命名步骤", 120),
        summary: cleanText(input.summary, "等待补充说明"),
        status: STATUS_VALUES.has(input.status) ? input.status : "pending",
        kind: cleanText(input.kind, input.parentId ? "substep" : "major", 40),
        notes: cleanList(input.notes),
        conversationRefs: cleanConversationRefs(input.conversationRefs)
      };
      const afterIndex = state.steps.findIndex((item) => item.id === input.afterId);
      if (afterIndex >= 0) state.steps.splice(afterIndex + 1, 0, step);
      else state.steps.push(step);
    });
  }

  updateStep(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const step = state.steps.find((item) => item.id === input.id);
      if (!step) throw new Error(`Unknown step: ${input.id}`);
      if (input.title !== undefined) step.title = cleanText(input.title, step.title, 120);
      if (input.summary !== undefined) step.summary = cleanText(input.summary, step.summary);
      if (input.status !== undefined && STATUS_VALUES.has(input.status)) step.status = input.status;
      if (input.kind !== undefined) step.kind = cleanText(input.kind, step.kind, 40);
      if (input.parentId !== undefined) {
        step.parentId = cleanText(input.parentId, "", 120) || null;
        state.layout.parentById[step.id] = step.parentId;
      }
      if (input.notes !== undefined) step.notes = cleanList(input.notes);
      if (input.conversationRefs !== undefined) step.conversationRefs = cleanConversationRefs(input.conversationRefs);
    });
  }

  attachFile(sessionId, input) {
    const filePath = checkedDocumentPath(input.path);
    return this.#mutate(sessionId, (state) => {
      const stepId = cleanText(input.stepId, "", 120) || null;
      if (stepId && !state.steps.some((step) => step.id === stepId)) throw new Error("找不到要关联的流程步骤");
      const existing = state.artifacts.find((artifact) => artifact.path.toLowerCase() === filePath.toLowerCase());
      if (existing) {
        existing.createdByStepId = stepId;
        existing.name = cleanText(input.name, existing.name, 160);
        existing.status = "ready";
        return;
      }
      const extension = extname(filePath).slice(1).toUpperCase();
      state.artifacts.push({
        id: randomUUID(),
        name: cleanText(input.name, basename(filePath), 160),
        role: input.role === "input" ? "input" : "output",
        status: "ready",
        createdByStepId: stepId,
        path: filePath,
        format: cleanText(input.format, extension ? `${extension} 文件` : "文档", 240),
        rules: cleanList(input.rules, 12),
        source: null
      });
    });
  }

  removeFile(sessionId, artifactId) {
    return this.#mutate(sessionId, (state) => {
      const artifact = state.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new Error("找不到这个相关文件");
      state.artifacts = state.artifacts.filter((item) => item.id !== artifactId);
      state.dependencies = state.dependencies.filter((item) => item.targetArtifactId !== artifactId && item.sourceArtifactId !== artifactId);
      state.issues = state.issues.map((item) => item.artifactId === artifactId ? { ...item, artifactId: null } : item);
    });
  }

  openFile(sessionId, artifactId, opener) {
    const state = this.get(sessionId);
    const artifact = state.artifacts.find((item) => item.id === artifactId);
    if (!artifact?.path) throw new Error("这个条目没有可打开的原始文件");
    const filePath = checkedDocumentPath(artifact.path);
    opener(filePath);
    return { id: artifact.id, name: artifact.name, path: filePath };
  }

  moveStep(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const displaySteps = applyLayout(state.steps, state.layout);
      const step = displaySteps.find((item) => item.id === input.id);
      if (!step) throw new Error(`Unknown step: ${input.id}`);
      const parentId = cleanText(input.parentId, "", 120) || null;
      const afterId = cleanText(input.afterId, "", 120) || null;
      const beforeId = cleanText(input.beforeId, "", 120) || null;
      if (afterId && beforeId) throw new Error("移动位置不能同时指定前面和后面");
      if (parentId === step.id || afterId === step.id || beforeId === step.id) throw new Error("不能把步骤移动到自己上");

      if (parentId) {
        const parent = displaySteps.find((item) => item.id === parentId);
        if (!parent) throw new Error("找不到目标主步骤");
        if (parent.parentId) throw new Error("次级步骤下面不能再放步骤");
        if (displaySteps.some((item) => item.parentId === step.id)) {
          throw new Error("这个主步骤仍有次级步骤，请先移动其子步骤");
        }
      }

      if (afterId) {
        const after = displaySteps.find((item) => item.id === afterId);
        if (!after) throw new Error("找不到目标步骤");
        const compatible = parentId ? after.id === parentId || after.parentId === parentId : !after.parentId;
        if (!compatible) throw new Error("目标步骤与新层级不一致");
      }
      if (beforeId) {
        const before = displaySteps.find((item) => item.id === beforeId);
        if (!before) throw new Error("找不到目标步骤");
        const compatible = parentId ? before.parentId === parentId : !before.parentId;
        if (!compatible) throw new Error("目标步骤与新层级不一致");
      }

      state.layout.order = state.layout.order.filter((id) => id !== step.id);
      state.layout.parentById[step.id] = parentId;

      if (afterId) {
        const targetIndex = state.layout.order.indexOf(afterId);
        state.layout.order.splice(targetIndex + 1, 0, step.id);
        return;
      }
      if (beforeId) {
        const targetIndex = state.layout.order.indexOf(beforeId);
        state.layout.order.splice(targetIndex, 0, step.id);
        return;
      }
      if (parentId) {
        let targetIndex = state.layout.order.indexOf(parentId);
        state.layout.order.forEach((id, index) => {
          if (state.layout.parentById[id] === parentId) targetIndex = index;
        });
        state.layout.order.splice(targetIndex + 1, 0, step.id);
        return;
      }
      state.layout.order.push(step.id);
    });
  }

  restoreOriginalLayout(sessionId) {
    return this.#mutate(sessionId, (state) => {
      state.layout = createLayout(state.steps);
    });
  }

  groupStep(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const displaySteps = applyLayout(state.steps, state.layout);
      const step = displaySteps.find((item) => item.id === input.id);
      if (!step) throw new Error(`Unknown step: ${input.id}`);
      if (!step.parentId) throw new Error("只有次级步骤可以拖到空白处新建主步骤");
      const beforeId = cleanText(input.beforeId, "", 120) || null;
      const afterId = cleanText(input.afterId, "", 120) || null;
      if (beforeId && afterId) throw new Error("新分组位置不能同时指定前后");
      const placementTargetId = beforeId || afterId;
      if (placementTargetId) {
        const target = displaySteps.find((item) => item.id === placementTargetId);
        if (!target || target.parentId) throw new Error("新分组只能放在两个主步骤之间");
      }
      const groupId = `group-${randomUUID()}`;
      const group = {
        id: groupId,
        parentId: null,
        title: cleanText(input.title, suggestGroupTitle(step.title), 120),
        summary: `整理视图中围绕“${step.title}”自动建立的主步骤。`,
        status: step.status === "done" ? "done" : "active",
        kind: "major",
        notes: [],
        conversationRefs: [],
        virtual: true
      };
      state.layout.groups.push(group);
      state.layout.order = state.layout.order.filter((id) => id !== step.id);
      let insertAt = state.layout.order.length;
      if (beforeId) insertAt = state.layout.order.indexOf(beforeId);
      if (afterId) {
        insertAt = state.layout.order.indexOf(afterId) + 1;
        while (insertAt < state.layout.order.length && state.layout.parentById[state.layout.order[insertAt]] === afterId) insertAt += 1;
      }
      if (insertAt < 0) insertAt = state.layout.order.length;
      state.layout.order.splice(insertAt, 0, groupId, step.id);
      state.layout.parentById[groupId] = null;
      state.layout.parentById[step.id] = groupId;
    });
  }

  renameLayoutGroup(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const group = state.layout.groups.find((item) => item.id === input.id);
      if (!group) throw new Error("找不到整理视图分组");
      group.title = cleanText(input.title, group.title, 120);
    });
  }

  deleteStep(sessionId, stepId) {
    return this.#mutate(sessionId, (state) => {
      const target = state.steps.find((item) => item.id === stepId);
      if (!target) throw new Error(`Unknown step: ${stepId}`);
      state.steps = state.steps.filter((item) => item.id !== stepId).map((item) => {
        if (item.parentId !== stepId) return item;
        return { ...item, parentId: null, kind: "major" };
      });
      state.artifacts = state.artifacts.map((item) => item.createdByStepId === stepId ? { ...item, createdByStepId: null } : item);
      state.issues = state.issues.map((item) => item.stepId === stepId ? { ...item, stepId: null } : item);
    });
  }

  syncFlow(sessionId, input) {
    return this.#mutate(sessionId, (state) => {
      const existingIds = new Map(state.steps.map((step) => [step.title.toLowerCase(), step.id]));
      state.title = cleanText(input.title, state.title, 120);
      state.project = cleanText(input.project, state.project, 120);
      if (input.recording !== undefined) state.recording = Boolean(input.recording);
      state.steps = input.steps.map((item) => ({
        id: cleanText(item.id, existingIds.get(cleanText(item.title).toLowerCase()) || randomUUID(), 120),
        parentId: cleanText(item.parentId, "", 120) || null,
        title: cleanText(item.title, "未命名步骤", 120),
        summary: cleanText(item.summary, "等待补充说明"),
        status: STATUS_VALUES.has(item.status) ? item.status : "pending",
        kind: cleanText(item.kind, item.parentId ? "substep" : "major", 40),
        notes: cleanList(item.notes),
        conversationRefs: cleanConversationRefs(item.conversationRefs)
      }));
      if (input.artifacts !== undefined) state.artifacts = normalizeState({ artifacts: input.artifacts }).artifacts;
      if (input.issues !== undefined) state.issues = normalizeState({ issues: input.issues }).issues;
    });
  }

  linkArtifact(sessionId, input) {
    const all = this.#readAll();
    const sourceState = all[input.sourceSessionId] ? normalizeState(all[input.sourceSessionId]) : null;
    if (!sourceState) throw new Error("找不到来源项目");
    const sourceArtifact = sourceState.artifacts.find((item) => item.id === input.sourceArtifactId && item.role === "output");
    if (!sourceArtifact) throw new Error("找不到来源项目的产出物");

    return this.#mutate(sessionId, (state) => {
      const existing = state.dependencies.find((item) => item.sourceSessionId === input.sourceSessionId && item.sourceArtifactId === input.sourceArtifactId);
      if (existing) return;
      const targetArtifactId = randomUUID();
      state.artifacts.push({
        ...sourceArtifact,
        id: targetArtifactId,
        role: "input",
        status: "linked",
        format: `来自${sourceState.project} · ${sourceArtifact.format}`,
        source: { sessionId: input.sourceSessionId, artifactId: input.sourceArtifactId }
      });
      state.dependencies.push({ id: randomUUID(), type: "input-from", sourceSessionId: input.sourceSessionId, sourceArtifactId: input.sourceArtifactId, targetArtifactId, confirmed: true });
    });
  }

  traceLineage(sessionId, artifactId) {
    const all = this.#readAll();
    const current = normalizeState(all[sessionId] ?? createDefaultState());
    const inputArtifact = current.artifacts.find((item) => item.id === artifactId && item.role === "input");
    if (!inputArtifact?.source) throw new Error("这个文件还没有关联来源项目");
    const source = all[inputArtifact.source.sessionId] ? normalizeState(all[inputArtifact.source.sessionId]) : null;
    if (!source) throw new Error("来源项目已经不存在");
    const sourceArtifact = source.artifacts.find((item) => item.id === inputArtifact.source.artifactId);
    if (!sourceArtifact) throw new Error("来源产出物已经不存在");
    return {
      currentProject: { title: current.title, project: current.project },
      inputArtifact,
      sourceProject: { id: inputArtifact.source.sessionId, title: source.title, project: source.project },
      sourceArtifact,
      sourceSteps: source.steps.filter((step) => !step.parentId || step.id === sourceArtifact.createdByStepId || step.parentId === sourceArtifact.createdByStepId),
      sourceRules: sourceArtifact.rules
    };
  }

  undo(sessionId) {
    const all = this.#readAll();
    const history = all.__history?.[sessionId];
    if (!Array.isArray(history) || history.length === 0) throw new Error("没有可以还原的修改");
    const previous = history.pop();
    all[sessionId] = normalizeState(previous);
    all[sessionId].updatedAt = new Date().toISOString();
    this.#writeAll(all);
    return this.#decorate(all[sessionId], all, sessionId);
  }

  reset(sessionId) {
    return this.#mutate(sessionId, (state) => {
      const fresh = createDefaultState();
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, fresh);
    });
  }
}
