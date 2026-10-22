//! Markdown diagnostic report (`web/agent_report.js`).
//!
//! One report per task: what was asked, what the assistant planned, what was
//! actually sent, what came back, and what is durable about the device. Built
//! for a bug report or a shift handover, so everything passes through the same
//! redaction and the size is capped.

use super::redact::redact_task_text;

pub const REPORT_MAX_CHARS: usize = 200000;
pub const REPORT_EVIDENCE_CHARS: usize = 2000;

/// A plan step as the report renders it.
#[derive(Debug, Clone)]
pub struct ReportPlanStep {
    pub title: String,
    pub status: String,
    pub verification: String,
    pub next_action: String,
}

/// A target execution as the report renders it.
#[derive(Debug, Clone)]
pub struct ReportExecution {
    pub id: String,
    pub payload: String,
    pub delivery: String,
    pub execution_status: String,
    pub exit_code: Option<i64>,
    pub observation: String,
    pub error: String,
    pub download_path: String,
    pub download_bytes: Option<u64>,
    pub download_sha256: String,
    pub evidence: String,
}

#[derive(Debug, Clone)]
pub struct ReportTask {
    pub goal: String,
    pub status: String,
    pub summary: String,
    pub plan: Vec<ReportPlanStep>,
}

#[derive(Debug, Clone)]
pub struct ReportNote {
    pub text: String,
    pub evidence: String,
}

#[derive(Debug, Clone)]
pub struct ReportEarlierTask {
    pub goal: String,
    pub status: String,
    pub updated_at: Option<u64>,
}

/// Join non-empty parts with " · ".
fn line(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Drop control characters that would break Markdown layout; keep the text.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(*c as u32, 0x00..=0x08 | 0x0b..=0x1f | 0x7f))
        .filter(|c| *c != '\r')
        .collect()
}

fn plan_section(plan: &[ReportPlanStep], zh: bool) -> Vec<String> {
    if plan.is_empty() {
        return Vec::new();
    }
    let mut out = vec![
        if zh { "## 计划" } else { "## Plan" }.to_string(),
        String::new(),
    ];
    for step in plan {
        let title = redact_task_text(&step.title);
        out.push(
            format!(
                "- [{}] {}",
                if step.status.is_empty() {
                    "pending"
                } else {
                    &step.status
                },
                title
            )
            .trim_end()
            .to_string(),
        );
        if !step.verification.is_empty() {
            out.push(format!(
                "  - {}: {}",
                if zh { "验证" } else { "Verification" },
                redact_task_text(&step.verification)
            ));
        }
        if !step.next_action.is_empty() {
            out.push(format!(
                "  - {}: {}",
                if zh { "下一步" } else { "Next" },
                redact_task_text(&step.next_action)
            ));
        }
    }
    out.push(String::new());
    out
}

fn execution_section(records: &[ReportExecution], zh: bool) -> Vec<String> {
    if records.is_empty() {
        return Vec::new();
    }
    let mut out = vec![
        if zh {
            "## 串口执行记录"
        } else {
            "## Target executions"
        }
        .to_string(),
        String::new(),
    ];
    for record in records {
        out.push(format!(
            "### {}",
            if record.id.is_empty() {
                "execution"
            } else {
                &record.id
            }
        ));
        let command = line(&[
            if zh { "命令" } else { "Command" },
            &format!("`{}`", printable(&redact_task_text(&record.payload))),
        ]);
        out.push(command);
        let exit = record
            .exit_code
            .map(|c| format!("{} {c}", if zh { "退出码" } else { "exit code" }))
            .unwrap_or_default();
        out.push(line(&[
            if zh { "投递" } else { "Delivery" },
            &record.delivery,
            &record.execution_status,
            &exit,
            &record.observation,
        ]));
        if !record.error.is_empty() {
            out.push(line(&[
                if zh { "错误" } else { "Error" },
                &redact_task_text(&record.error),
            ]));
        }
        if !record.download_path.is_empty()
            || record.download_bytes.is_some()
            || !record.download_sha256.is_empty()
        {
            let bytes = record
                .download_bytes
                .map(|b| format!("{b} bytes"))
                .unwrap_or_default();
            let sha = if record.download_sha256.is_empty() {
                String::new()
            } else {
                format!("SHA-256 {}", record.download_sha256)
            };
            out.push(line(&[
                if zh { "下载" } else { "Download" },
                &redact_task_text(&record.download_path),
                &bytes,
                &sha,
            ]));
        }
        if !record.evidence.is_empty() {
            let evidence: String = printable(&redact_task_text(&record.evidence))
                .chars()
                .rev()
                .take(REPORT_EVIDENCE_CHARS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            out.push(String::new());
            out.push("```text".to_string());
            out.push(evidence);
            out.push("```".to_string());
        }
        out.push(String::new());
    }
    out
}

/// Build the full report. `zh` selects the Chinese labels.
pub fn build_task_report(
    zh: bool,
    device: &str,
    generated_iso: &str,
    task: Option<&ReportTask>,
    earlier_tasks: &[ReportEarlierTask],
    records: &[ReportExecution],
    notes: &[ReportNote],
) -> String {
    let mut out = vec![
        if zh {
            "# Linkr Bee 排查报告"
        } else {
            "# Linkr Bee diagnostic report"
        }
        .to_string(),
        String::new(),
        line(&[
            if zh { "设备" } else { "Device" },
            &redact_task_text(device),
        ]),
        line(&[if zh { "生成时间" } else { "Generated" }, generated_iso]),
    ];
    if let Some(task) = task {
        if !task.goal.is_empty() {
            out.push(line(&[
                if zh { "目标" } else { "Goal" },
                &redact_task_text(&task.goal),
            ]));
        }
        if !task.status.is_empty() {
            out.push(line(&[if zh { "状态" } else { "Status" }, &task.status]));
        }
    }
    out.push(String::new());

    if let Some(task) = task {
        if !task.summary.is_empty() {
            out.push(
                if zh {
                    "## 助手结论"
                } else {
                    "## Assistant summary"
                }
                .to_string(),
            );
            out.push(String::new());
            out.push(redact_task_text(&task.summary));
            out.push(String::new());
        }
        out.extend(plan_section(&task.plan, zh));
    }
    out.extend(execution_section(records, zh));

    if !notes.is_empty() {
        out.push(
            if zh {
                "## 设备笔记"
            } else {
                "## Device notes"
            }
            .to_string(),
        );
        out.push(String::new());
        for note in notes {
            let mut bullet = format!("- {}", redact_task_text(&note.text));
            if !note.evidence.is_empty() {
                bullet.push_str(&format!(" ({})", redact_task_text(&note.evidence)));
            }
            out.push(bullet);
        }
        out.push(String::new());
    }

    if !earlier_tasks.is_empty() {
        out.push(
            if zh {
                "## 该设备的历史任务"
            } else {
                "## Earlier tasks on this device"
            }
            .to_string(),
        );
        out.push(String::new());
        for item in earlier_tasks {
            let ts = item
                .updated_at
                .map(|t| format!(" ({t})"))
                .unwrap_or_default();
            out.push(format!(
                "- {} — {}{ts}",
                redact_task_text(&item.goal),
                item.status
            ));
        }
        out.push(String::new());
    }

    out.push(
        if zh {
            "> 退出码与助手结论都不等于目标达成；请以报告中的证据片段自行核对。"
        } else {
            "> Exit codes and assistant conclusions are not proof that the goal was met; check the quoted evidence."
        }
        .to_string(),
    );

    let report = out.join("\n");
    if report.chars().count() > REPORT_MAX_CHARS {
        let head: String = report.chars().take(REPORT_MAX_CHARS).collect();
        format!("{head}\n\n[truncated]")
    } else {
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution(id: &str, payload: &str, evidence: &str) -> ReportExecution {
        ReportExecution {
            id: id.to_string(),
            payload: payload.to_string(),
            delivery: "sent".to_string(),
            execution_status: "completed".to_string(),
            exit_code: Some(0),
            observation: "prompt-returned".to_string(),
            error: String::new(),
            download_path: String::new(),
            download_bytes: None,
            download_sha256: String::new(),
            evidence: evidence.to_string(),
        }
    }

    #[test]
    fn a_full_report_carries_every_section() {
        let task = ReportTask {
            goal: "diagnose boot loop".to_string(),
            status: "done".to_string(),
            summary: "reset the watchdog".to_string(),
            plan: vec![ReportPlanStep {
                title: "read dmesg".to_string(),
                status: "completed".to_string(),
                verification: "no panic".to_string(),
                next_action: String::new(),
            }],
        };
        let report = build_task_report(
            false,
            "target:1",
            "2026-01-01T00:00:00Z",
            Some(&task),
            &[],
            &[execution("serial-1", "dmesg", "kernel panic\n")],
            &[],
        );
        assert!(report.contains("# Linkr Bee diagnostic report"));
        assert!(report.contains("## Plan"));
        assert!(report.contains("## Target executions"));
        assert!(report.contains("```text"));
        assert!(report.contains("exit code 0"));
    }

    #[test]
    fn chinese_labels_are_used_when_requested() {
        let report = build_task_report(true, "target:1", "t", None, &[], &[], &[]);
        assert!(report.contains("# Linkr Bee 排查报告"));
    }

    #[test]
    fn credentials_are_redacted_in_the_report() {
        let report = build_task_report(
            false,
            "target:1",
            "t",
            None,
            &[],
            &[execution("serial-1", "password: secret", "")],
            &[],
        );
        assert!(!report.contains("secret"));
        assert!(report.contains("[redacted]"));
    }

    #[test]
    fn control_characters_are_stripped_from_evidence() {
        let report = build_task_report(
            false,
            "target:1",
            "t",
            None,
            &[],
            &[execution("serial-1", "x", "a\u{1b}b\rc")],
            &[],
        );
        assert!(report.contains("abc"));
        assert!(!report.contains('\u{1b}'));
        assert!(!report.contains('\r'));
    }
}
