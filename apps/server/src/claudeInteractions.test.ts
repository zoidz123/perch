import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { ClaudeInteractionCoordinator } from "./claudeInteractions.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { TaskStore } from "./tasks.js";
class Adapter implements AgentAdapter { readonly name="interactions"; async getTopology(){return {windows:[],generatedAt:""};} async listSessions(){return [];} async readRecentEvents(){return {events:[],terminal:true};} async sendInput(){} async sendEnter(){} async interrupt(){} }
function fixture(){const home=mkdtempSync(join(tmpdir(),"perch-interactions-"));const tasks=new TaskStore({PERCH_HOME:home});const monitor=new FleetMonitor(new Adapter(),{reconcileMs:60_000});const coordinator=new ClaudeInteractionCoordinator(tasks,monitor,{deadlineMs:500,pollMs:2});return{tasks,monitor,coordinator,close(){monitor.stop();tasks.close();rmSync(home,{recursive:true,force:true});}};}

test("form and URL elicitation use exact id CAS and documented action output", async()=>{for(const mode of ["form","url"] as const){const f=fixture();try{const payload={hook_event_name:"Elicitation",session_id:"c",mcp_server_name:"auth",elicitation_id:`e-${mode}`,mode,message:"Continue",...(mode==="form"?{requested_schema:{type:"object",required:["name"],properties:{name:{type:"string"}}}}:{url:"https://example.test/auth"})};const record=f.coordinator.register("pty:w",payload).record!;const content=mode==="form"?{name:"Kevin"}:undefined;assert.equal(f.coordinator.respond("pty:w",record.id,"accept",content,"boss:device").status,202);assert.equal(f.coordinator.respond("pty:w",record.id,"accept",content,"boss:device").body.idempotent,true);assert.equal(f.coordinator.respond("pty:w",record.id,"decline",undefined,"boss:device").status,409);const decided=await f.coordinator.wait(record.id);assert.deepEqual(f.coordinator.hookOutput(decided),{hookSpecificOutput:{hookEventName:"Elicitation",action:"accept",...(content?{content}:{})}});}finally{f.close();}}});
test("PermissionDenied is durable visible evidence and never an approval",()=>{const f=fixture();try{const record=f.coordinator.observePermissionDenied("pty:w",{hook_event_name:"PermissionDenied",session_id:"c",tool_use_id:"tool-1",tool_name:"Bash"});assert.equal(record.state,"observed");assert.equal(f.monitor.pendingApproval("pty:w"),undefined);assert.equal(f.monitor.pendingClaudeInteraction("pty:w")?.kind,"permission_denied");}finally{f.close();}});
