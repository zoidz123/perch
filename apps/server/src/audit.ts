import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditAction =
  | "input"
  | "resize"
  | "submit"
  | "enter"
  | "interrupt"
  | "start_agent"
  | "recover_agent"
  | "stop_session"
  | "pair_device"
  | "revoke_device"
  | "approve"
  | "deny"
  | "answer"
  | "attach"
  | "model"
  | "add_project"
  | "remove_project"
  | "set_config"
  | "no_mistakes_init"
  | "release_worktree"
  | "register_chart"
  | "finalize_chart"
  | "chart_feedback"
  | "chart_layout"
  | "task_decision"
  | "task_completion_decision";

export type AuditRecord = {
  at: string;
  action: AuditAction;
  sessionId?: string;
  deviceId?: string;
  remoteAddress?: string;
  textLength?: number;
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  // Task linkage (M1): set when the action ran on behalf of a task.
  taskId?: string;
  forced?: boolean;
  // Pool linkage (M0): set when the action ran on a worktree slot.
  worktreeId?: string;
  // Chart linkage: set when the action ran on a registered chart.
  chartId?: string;
  approvalId?: string;
  decision?: string;
};

export class AuditLog {
  constructor(private readonly path: string) {}

  async write(record: Omit<AuditRecord, "at">): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, "utf8");
  }
}
