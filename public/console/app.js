const state = {
  runs: [],
  selectedId: null,
  filter: "all",
  detail: null,
  events: [],
};

const elements = {
  projectName: document.querySelector("#project-name"),
  runCount: document.querySelector("#run-count"),
  runList: document.querySelector("#run-list"),
  emptyState: document.querySelector("#empty-state"),
  runDetail: document.querySelector("#run-detail"),
  runId: document.querySelector("#run-id"),
  runStatus: document.querySelector("#run-status"),
  activeIndicator: document.querySelector("#active-indicator"),
  runTitle: document.querySelector("#run-title"),
  runDescription: document.querySelector("#run-description"),
  detailActions: document.querySelector("#detail-actions"),
  runAlert: document.querySelector("#run-alert"),
  currentGate: document.querySelector("#current-gate"),
  changedCount: document.querySelector("#changed-count"),
  checkScore: document.querySelector("#check-score"),
  reviewScore: document.querySelector("#review-score"),
  baseSha: document.querySelector("#base-sha"),
  planContent: document.querySelector("#plan-content"),
  evidenceContent: document.querySelector("#evidence-content"),
  approvalContent: document.querySelector("#approval-content"),
  timeline: document.querySelector("#timeline"),
  dialog: document.querySelector("#task-dialog"),
  taskForm: document.querySelector("#task-form"),
  submit: document.querySelector("#create-run-submit"),
  toast: document.querySelector("#toast"),
};

const statusMeta = {
  PLANNING: ["正在规划", "active"],
  AWAITING_PLAN_APPROVAL: ["等待审批", "waiting"],
  PLAN_APPROVED: ["计划已批准", "success"],
  PLAN_REJECTED: ["计划已拒绝", "failure"],
  IMPLEMENTING: ["正在实施", "active"],
  VERIFYING: ["正在验证", "active"],
  VERIFICATION_FAILED: ["验证失败", "failure"],
  REVIEWING: ["正在审查", "active"],
  REVIEW_FAILED: ["审查失败", "failure"],
  READY_FOR_PR: ["可以发布", "success"],
  PR_CREATED: ["Draft PR 已创建", "success"],
  FAILED: ["运行失败", "failure"],
};

const activeStatuses = new Set([
  "PLANNING",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
]);
const attentionStatuses = new Set([
  "AWAITING_PLAN_APPROVAL",
  "PLAN_APPROVED",
  "VERIFICATION_FAILED",
  "REVIEW_FAILED",
  "READY_FOR_PR",
  "FAILED",
]);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.remove("is-hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(
    () => elements.toast.classList.add("is-hidden"),
    4200,
  );
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function statusInfo(status) {
  return statusMeta[status] || [status, ""];
}

function renderRuns() {
  elements.runCount.textContent = String(state.runs.length);
  elements.runList.replaceChildren();
  const runs = state.runs.filter((run) => {
    if (state.filter === "attention") return attentionStatuses.has(run.status);
    if (state.filter === "active")
      return run.active || activeStatuses.has(run.status);
    return true;
  });
  if (!runs.length) {
    elements.runList.append(
      node(
        "div",
        "empty-rail",
        state.runs.length ? "没有符合条件的运行" : "还没有运行",
      ),
    );
    return;
  }
  runs.forEach((run) => {
    const [label, tone] = statusInfo(run.status);
    const button = node(
      "button",
      `run-card${run.id === state.selectedId ? " is-selected" : ""}`,
    );
    button.type = "button";
    button.dataset.runId = run.id;
    const top = node("div", "run-card-top");
    top.append(node("span", "run-code", run.id.slice(-13)));
    top.append(node("span", `status-dot ${run.active ? "active" : tone}`));
    button.append(top, node("div", "run-card-title", run.task.title));
    const meta = node("div", "run-card-meta");
    meta.append(
      node("span", "", label),
      node("span", "", formatTime(run.updatedAt)),
    );
    button.append(meta);
    button.addEventListener("click", () => selectRun(run.id));
    elements.runList.append(button);
  });
}

function addListSection(parent, title, items, ordered = false) {
  if (!items?.length) return;
  const section = node("div", "plan-section");
  section.append(node("h4", "", title));
  const list = node(ordered ? "ol" : "ul");
  items.forEach((item) => list.append(node("li", "", item)));
  section.append(list);
  parent.append(section);
}

function renderPlan(run) {
  elements.planContent.replaceChildren();
  if (!run.plan) {
    elements.planContent.append(node("p", "muted", "计划尚未生成。"));
    return;
  }
  try {
    const plan = JSON.parse(run.plan);
    elements.planContent.append(node("p", "plan-summary", plan.summary || "—"));
    addListSection(elements.planContent, "实施步骤", plan.steps, true);
    if (plan.expectedFiles?.length) {
      const section = node("div", "plan-section");
      section.append(node("h4", "", "预计文件"));
      const tags = node("div", "file-tags");
      plan.expectedFiles.forEach((file) =>
        tags.append(node("span", "file-tag", file)),
      );
      section.append(tags);
      elements.planContent.append(section);
    }
    addListSection(elements.planContent, "验证方式", plan.verification);
    addListSection(elements.planContent, "已知风险", plan.risks);
  } catch {
    elements.planContent.append(node("pre", "file-tag", run.plan));
  }
}

function renderEvidence(run) {
  elements.evidenceContent.replaceChildren();
  const allChecks = [...(run.setupChecks || []), ...(run.checks || [])];
  if (allChecks.length) {
    const list = node("div", "check-list");
    allChecks.forEach((check) => {
      const row = node("div", "check-row");
      row.append(
        node(
          "span",
          `check-symbol${check.exitCode ? " fail" : ""}`,
          check.exitCode ? "×" : "✓",
        ),
        node("span", "", check.name),
        node("span", "check-time", `${check.durationMs} ms`),
      );
      list.append(row);
    });
    elements.evidenceContent.append(list);
  } else {
    elements.evidenceContent.append(node("p", "muted", "尚无确定性检查结果。"));
  }
  if (run.changedPaths?.length) {
    const section = node("div", "plan-section");
    section.append(node("h4", "", "实际变更"));
    const tags = node("div", "file-tags");
    run.changedPaths.forEach((file) =>
      tags.append(node("span", "file-tag", file)),
    );
    section.append(tags);
    elements.evidenceContent.append(section);
  }
  if (run.review) {
    const block = node("div", "review-block");
    block.append(
      node(
        "strong",
        "",
        run.review.verdict === "pass" ? "独立审查通过" : "独立审查未通过",
      ),
    );
    block.append(node("p", "", run.review.summary));
    run.review.findings?.forEach((finding) => {
      const item = node("div", "finding");
      item.append(
        node(
          "strong",
          "",
          `${finding.severity.toUpperCase()} · ${finding.title}`,
        ),
      );
      item.append(
        node("p", "", finding.evidence),
        node("p", "", finding.recommendation),
      );
      block.append(item);
    });
    elements.evidenceContent.append(block);
  }
}

function renderApproval(run) {
  elements.approvalContent.replaceChildren();
  if (run.status === "AWAITING_PLAN_APPROVAL") {
    elements.approvalContent.append(
      node(
        "p",
        "approval-copy",
        "确认计划范围、风险与验证方式。批准记录会绑定当前计划、项目配置和基线提交。",
      ),
    );
    const form = node("div", "approval-form");
    const actorLabel = node("label", "", "审批人");
    const actor = node("input");
    actor.value = localStorage.getItem("autosdlc.approver") || "";
    actor.placeholder = "输入姓名或工号";
    actorLabel.append(actor);
    const noteLabel = node("label", "", "审批意见");
    const note = node("textarea");
    note.rows = 4;
    note.placeholder = "批准可选；拒绝时必须说明原因";
    noteLabel.append(note);
    const buttons = node("div", "approval-buttons");
    const reject = node("button", "button button-danger", "拒绝计划");
    reject.type = "button";
    const approve = node("button", "button button-primary", "批准计划");
    approve.type = "button";
    reject.addEventListener("click", () =>
      decidePlan("rejected", actor.value, note.value),
    );
    approve.addEventListener("click", () =>
      decidePlan("approved", actor.value, note.value),
    );
    buttons.append(reject, approve);
    form.append(actorLabel, noteLabel, buttons);
    elements.approvalContent.append(form);
    return;
  }
  if (run.approval) {
    const record = node(
      "div",
      `decision-record${run.approval.decision === "rejected" ? " rejected" : ""}`,
    );
    record.append(
      node(
        "strong",
        "",
        run.approval.decision === "approved" ? "计划已批准" : "计划已拒绝",
      ),
    );
    record.append(node("p", "", run.approval.note || "未填写审批意见"));
    record.append(
      node(
        "div",
        "decision-meta",
        `${run.approval.actor} · ${formatTime(run.approval.decidedAt)}`,
      ),
    );
    elements.approvalContent.append(record);
  } else {
    elements.approvalContent.append(
      node("p", "muted", "运行尚未到达人工审批关卡。"),
    );
  }
}

function actionButton(label, className, handler, disabled = false) {
  const button = node("button", `button ${className}`, label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function renderActions(run) {
  elements.detailActions.replaceChildren();
  if (run.pullRequestUrl) {
    const link = node("a", "button button-primary", "打开 Draft PR");
    link.href = run.pullRequestUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    elements.detailActions.append(link);
  }
  if (run.status === "PLAN_APPROVED") {
    elements.detailActions.append(
      actionButton(
        "开始实施",
        "button-primary",
        () => triggerAction("continue"),
        run.active,
      ),
    );
  }
  if (
    ["VERIFICATION_FAILED", "REVIEW_FAILED", "FAILED"].includes(run.status) &&
    run.approval?.decision === "approved"
  ) {
    elements.detailActions.append(
      actionButton(
        "修复并重试",
        "button-ghost",
        () => triggerAction("continue"),
        run.active,
      ),
    );
  }
  if (
    ["IMPLEMENTING", "VERIFYING", "REVIEWING"].includes(run.status) &&
    !run.active &&
    run.approval?.decision === "approved"
  ) {
    elements.detailActions.append(
      actionButton(
        "恢复运行",
        "button-ghost",
        () => triggerAction("continue"),
      ),
    );
  }
  if (run.status === "READY_FOR_PR") {
    elements.detailActions.append(
      actionButton(
        "创建 Draft PR",
        "button-primary",
        () => triggerAction("publish"),
        run.active,
      ),
    );
  }
}

function renderTimeline(events) {
  elements.timeline.replaceChildren();
  if (!events.length) {
    elements.timeline.append(node("li", "muted", "暂无事件。"));
    return;
  }
  [...events]
    .reverse()
    .slice(0, 14)
    .forEach((event) => {
      const item = node("li", "timeline-item");
      item.append(node("span", "timeline-marker"));
      const copy = node("div");
      copy.append(node("div", "timeline-event", event.type));
      copy.append(node("div", "timeline-time", formatTime(event.timestamp)));
      item.append(copy);
      elements.timeline.append(item);
    });
}

function renderDetail() {
  const run = state.detail;
  elements.emptyState.classList.toggle("is-hidden", Boolean(run));
  elements.runDetail.classList.toggle("is-hidden", !run);
  if (!run) return;
  const [label, tone] = statusInfo(run.status);
  elements.runId.textContent = run.id;
  elements.runStatus.textContent = label;
  elements.runStatus.className = `status-pill ${tone}`;
  elements.activeIndicator.classList.toggle("is-hidden", !run.active);
  elements.runTitle.textContent = run.task.title;
  elements.runDescription.textContent = run.task.description;
  elements.baseSha.textContent = `${run.baseBranch} · ${run.baseSha.slice(0, 9)}`;
  elements.currentGate.textContent = label;
  elements.changedCount.textContent = String(run.changedPaths?.length || 0);
  const checks = run.checks || [];
  elements.checkScore.textContent = checks.length
    ? `${checks.filter((item) => item.exitCode === 0).length}/${checks.length}`
    : "未开始";
  elements.reviewScore.textContent = run.review
    ? run.review.verdict === "pass"
      ? "通过"
      : "未通过"
    : "未开始";
  elements.runAlert.textContent = run.error || "";
  elements.runAlert.classList.toggle("is-hidden", !run.error);
  renderPlan(run);
  renderEvidence(run);
  renderApproval(run);
  renderActions(run);
  renderTimeline(state.events);
}

async function loadRuns(keepSelection = true) {
  state.runs = await api("/api/runs");
  if (
    !keepSelection ||
    !state.runs.some((run) => run.id === state.selectedId)
  ) {
    state.selectedId = state.runs[0]?.id || null;
  }
  renderRuns();
  if (state.selectedId) await loadDetail(state.selectedId);
  else {
    state.detail = null;
    state.events = [];
    renderDetail();
  }
}

async function loadDetail(runId) {
  const payload = await api(`/api/runs/${encodeURIComponent(runId)}`);
  state.selectedId = runId;
  state.detail = payload.run;
  state.events = payload.events;
  renderRuns();
  renderDetail();
}

async function selectRun(runId) {
  try {
    await loadDetail(runId);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function decidePlan(decision, actor, note) {
  if (!actor.trim()) return showToast("请填写审批人。", true);
  if (decision === "rejected" && !note.trim())
    return showToast("拒绝计划必须填写原因。", true);
  const question =
    decision === "approved"
      ? "批准后计划将被锁定。确认批准？"
      : "拒绝后本次运行将停止。确认拒绝？";
  if (!window.confirm(question)) return;
  localStorage.setItem("autosdlc.approver", actor.trim());
  try {
    await api(`/api/runs/${encodeURIComponent(state.selectedId)}/approval`, {
      method: "POST",
      body: JSON.stringify({ decision, actor, note }),
    });
    showToast(decision === "approved" ? "计划已批准。" : "计划已拒绝。");
    await loadRuns();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function triggerAction(action) {
  const prompt =
    action === "publish"
      ? "将提交已审查内容、推送分支并创建 Draft PR。继续？"
      : "开始调用 Agent 实施并执行验证？";
  if (!window.confirm(prompt)) return;
  try {
    await api(`/api/runs/${encodeURIComponent(state.selectedId)}/${action}`, {
      method: "POST",
      body: "{}",
    });
    showToast(action === "publish" ? "发布任务已启动。" : "实施任务已启动。");
    await loadRuns();
  } catch (error) {
    showToast(error.message, true);
  }
}

function lines(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

elements.taskForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const data = new FormData(elements.taskForm);
  elements.submit.disabled = true;
  elements.submit.textContent = "正在生成计划…";
  try {
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        title: data.get("title"),
        description: data.get("description"),
        acceptanceCriteria: lines(String(data.get("acceptanceCriteria") || "")),
        nonGoals: lines(String(data.get("nonGoals") || "")),
      }),
    });
    elements.dialog.close();
    elements.taskForm.reset();
    state.selectedId = run.id;
    showToast("计划已生成，等待人工审批。");
    await loadRuns();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.submit.disabled = false;
    elements.submit.textContent = "生成计划";
  }
});

document
  .querySelectorAll("#new-run-button, #empty-new-run")
  .forEach((button) => {
    button.addEventListener("click", () => elements.dialog.showModal());
  });
document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document
      .querySelectorAll(".filter-chip")
      .forEach((item) => item.classList.toggle("is-active", item === button));
    renderRuns();
  });
});

async function bootstrap() {
  try {
    const meta = await api("/api/meta");
    elements.projectName.textContent = meta.projectPath;
    await loadRuns(false);
    window.setInterval(() => loadRuns().catch(() => undefined), 3500);
  } catch (error) {
    elements.projectName.textContent = "控制面连接失败";
    showToast(error.message, true);
  }
}

void bootstrap();
