/* Markdown report for one task: what was asked, what the assistant planned,
 * what was actually sent to the target, what came back, and what is durable
 * about the device. Built for a bug report or a shift handover, so everything
 * passes through the same redaction as the task store and the size is capped.
 */
import { redactTaskText } from "./agent_tasks.js";

export const REPORT_MAX_CHARS = 200000;
export const REPORT_EVIDENCE_CHARS = 2000;

function line(...parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== "").join(" · ");
}

/* A serial payload or a log excerpt carries CR/LF and escape bytes that would
 * break the Markdown layout; keep the text, drop the control characters. */
function printable(text) {
  return String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\r/g, "");
}

function planSection(plan, zh) {
  if (!Array.isArray(plan) || !plan.length) return [];
  const out = [zh ? "## 计划" : "## Plan", ""];
  for (const step of plan) {
    out.push(`- [${step.status || "pending"}] ${redactTaskText(step.title || "")}`.trimEnd());
    if (step.verification) out.push(`  - ${zh ? "验证" : "Verification"}: ${redactTaskText(step.verification)}`);
    if (step.expectedResult) out.push(`  - ${zh ? "预期" : "Expected"}: ${redactTaskText(step.expectedResult)}`);
    if (step.completion) out.push(`  - ${zh ? "证据类别" : "Evidence category"}: ${step.completion}`);
    for (const evidence of step.evidence || []) out.push(`  - ${redactTaskText(evidence.id)}: ${redactTaskText(evidence.tool)} · ${redactTaskText(evidence.subject)} · ${redactTaskText(evidence.status)} · ${redactTaskText(JSON.stringify(evidence.expected || {}))}`);
    if (step.nextAction) out.push(`  - ${zh ? "下一步" : "Next"}: ${redactTaskText(step.nextAction)}`);
  }
  out.push("");
  return out;
}

function executionSection(records, zh) {
  if (!records.length) return [];
  const out = [zh ? "## 串口执行记录" : "## Target executions", ""];
  for (const record of records) {
    out.push(`### ${record.id || "execution"}`);
    out.push(line(zh ? "命令" : "Command", `\`${printable(redactTaskText(record.payload || ""))}\``));
    out.push(line(zh ? "投递" : "Delivery", record.delivery, record.executionStatus,
      record.exitCode === undefined ? "" : `${zh ? "退出码" : "exit code"} ${record.exitCode}`,
      record.observation));
    if (record.error) out.push(line(zh ? "错误" : "Error", redactTaskText(record.error)));
    if (record.download) {
      out.push(line(zh ? "下载" : "Download", redactTaskText(record.download.path || ""),
        record.download.bytes === undefined ? "" : `${record.download.bytes} bytes`,
        record.download.sha256 ? `SHA-256 ${record.download.sha256}` : ""));
    }
    if (record.evidence) {
      const evidence = printable(redactTaskText(record.evidence)).slice(-REPORT_EVIDENCE_CHARS);
      out.push("", "```text", evidence, "```");
    }
    out.push("");
  }
  return out;
}

export function buildTaskReport({ lang = "en", device = "", task = null, tasks = [], records = [], notes = [] } = {}) {
  const zh = String(lang).startsWith("zh");
  const out = [
    zh ? "# Linkr Bee 排查报告" : "# Linkr Bee diagnostic report",
    "",
    line(zh ? "设备" : "Device", redactTaskText(device)),
    line(zh ? "生成时间" : "Generated", new Date().toISOString()),
  ];
  if (task?.goal) out.push(line(zh ? "目标" : "Goal", redactTaskText(task.goal)));
  if (task?.status) out.push(line(zh ? "状态" : "Status", task.status));
  out.push("");

  if (task?.summary) {
    out.push(zh ? "## 助手结论" : "## Assistant summary", "", redactTaskText(task.summary), "");
  }
  out.push(...planSection(task?.plan, zh));
  out.push(...executionSection(records, zh));

  if (notes.length) {
    out.push(zh ? "## 设备笔记" : "## Device notes", "");
    for (const note of notes) {
      out.push(`- ${redactTaskText(note.text)}${note.evidence ? ` (${redactTaskText(note.evidence)})` : ""}`);
    }
    out.push("");
  }
  if (tasks.length) {
    out.push(zh ? "## 该设备的历史任务" : "## Earlier tasks on this device", "");
    for (const item of tasks) {
      out.push(`- ${redactTaskText(item.goal)} — ${item.status}${item.updatedAt ? ` (${new Date(item.updatedAt).toISOString()})` : ""}`);
    }
    out.push("");
  }
  out.push(zh
    ? "> 退出码与助手结论都不等于目标达成；请以报告中的证据片段自行核对。"
    : "> Exit codes and assistant conclusions are not proof that the goal was met; check the quoted evidence.");
  const report = out.join("\n");
  return report.length > REPORT_MAX_CHARS
    ? `${report.slice(0, REPORT_MAX_CHARS)}\n\n[truncated]`
    : report;
}
