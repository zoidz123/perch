import type { AuditLog } from "./audit.js";
import type { FleetMonitor } from "./fleetMonitor.js";
import { RECOVERY_CONTINUATION_TEXT } from "./runtimeManager.js";
import type { OperationRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";
import type { OperationExecutionContext } from "./taskScheduler.js";

type ContinuationPayload = {
  generation: number;
  sessionId: string;
  text: string;
  submitted?: boolean;
};

export class RecoveryContinuationCoordinator {
  constructor(private readonly options: {
    tasks: TaskStore;
    monitor: FleetMonitor;
    auditLog: AuditLog;
  }) {}

  async execute(operation: OperationRecord, context?: OperationExecutionContext): Promise<void> {
    const payload = parsePayload(operation);
    if (payload.submitted === true) return;
    const task = this.options.tasks.find(operation.taskId);
    if (!task) throw new Error(`Unknown task: ${operation.taskId}`);
    const runtime = this.options.tasks.stateDb.runtimes.latestForTask(task.id);

    if (
      task.state !== "working" ||
      !runtime ||
      runtime.state !== "live" ||
      runtime.generation !== payload.generation ||
      runtime.ptySessionId !== payload.sessionId
    ) {
      return;
    }

    // A recovered shell can surface a provider approval or question before
    // this durable intent drains. Recovery must never answer or queue behind
    // that park automatically; a later human action owns the next turn.
    const handoff = await this.options.monitor.queueOrSubmit(payload.sessionId, RECOVERY_CONTINUATION_TEXT, {
      queueIfGated: false
    });
    if (handoff.gated) return;
    context?.checkpoint({ ...payload, submitted: true });
    await this.options.auditLog.write({
      action: "input",
      taskId: task.id,
      sessionId: payload.sessionId,
      textLength: RECOVERY_CONTINUATION_TEXT.length
    });
  }
}

function parsePayload(operation: OperationRecord): ContinuationPayload {
  const payload = operation.payload;
  if (
    !payload ||
    !Number.isInteger(payload.generation) ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length === 0 ||
    payload.text !== RECOVERY_CONTINUATION_TEXT
  ) {
    throw new Error("continuation operation payload is incomplete or invalid");
  }
  return payload as ContinuationPayload;
}
