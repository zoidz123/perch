import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { ClaudeQuestionCoordinator } from "./claudeQuestions.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { TaskStore } from "./tasks.js";

class Adapter implements AgentAdapter { readonly name="questions"; async getTopology(){return {windows:[],generatedAt:""};} async listSessions(){return [];} async readRecentEvents(){return {events:[],terminal:true};} async sendInput(){} async sendEnter(){} async interrupt(){} }
function fixture() { const home=mkdtempSync(join(tmpdir(),"perch-questions-")); const tasks=new TaskStore({PERCH_HOME:home}); const monitor=new FleetMonitor(new Adapter(),{reconcileMs:60_000}); const coordinator=new ClaudeQuestionCoordinator(tasks,monitor,{deadlineMs:500,pollMs:2}); return {tasks,monitor,coordinator,close(){monitor.stop();tasks.close();rmSync(home,{recursive:true,force:true});}}; }
function payload(id:string, questions:unknown[]) { return {hook_event_name:"PreToolUse",session_id:"claude-1",tool_name:"AskUserQuestion",tool_use_id:id,tool_input:{questions}}; }
const single={question:"Choose?",header:"Choice",multiSelect:false,options:[{label:"A",description:"first"},{label:"B",description:"second"}]};

test("AskUserQuestion preserves 1-4 exact questions and returns original questions plus answers", async () => {
  for (const count of [1,2,3,4]) { const f=fixture(); try { const questions=Array.from({length:count},(_,i)=>({...single,question:`Choose ${i}?`})); const record=f.coordinator.register("pty:w",payload(`tool-${count}`,questions)).record!; const selections=questions.map(()=>[1]); f.coordinator.answer("pty:w",record.id,selections,undefined,"boss:device"); const decided=await f.coordinator.waitForAnswer(record.id); assert.deepEqual(f.coordinator.hookOutput(decided),{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Answered by the boss in Perch",updatedInput:{questions,answers:Object.fromEntries(questions.map(q=>[q.question,"B"]))}}}); } finally { f.close(); } }
});

test("multi-select and free-form Other are encoded under the exact question text", () => {
  const f=fixture(); try { const q={...single,multiSelect:true}; const record=f.coordinator.register("pty:w",payload("multi",[q])).record!; assert.equal(f.coordinator.answer("pty:w",record.id,[[0,1]],{[q.question]:"Other text"},"boss:device").status,202); assert.equal(f.tasks.stateDb.claudeQuestions.find(record.id)?.answers?.[q.question],"A, B, Other text"); } finally { f.close(); }
});

test("stale and duplicate answers CAS, while simultaneous calls visibly fall back", () => {
  const f=fixture(); try { const first=f.coordinator.register("pty:w",payload("one",[single])).record!; const second=f.coordinator.register("pty:w",payload("two",[{...single,question:"Second?"}])).record!; assert.equal(second.state,"simultaneous_fallback"); assert.equal(f.coordinator.answer("pty:w",first.id,[[0]],undefined,"boss:device").status,202); assert.equal(f.coordinator.answer("pty:w",first.id,[[0]],undefined,"boss:device").body.idempotent,true); assert.equal(f.coordinator.answer("pty:w",first.id,[[1]],undefined,"boss:device").status,409); } finally { f.close(); }
});
