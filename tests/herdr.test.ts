// Protect against duplicate dispatch after lost RPC replies, screen text mistaken for a receipt, stale context,
// unsafe session reuse, overlapping directory writers, and acknowledging cancellation before a terminal stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareTask, runTask, recoverTask, stopTask } from '../plugins/herdr-core/task.ts';
import { submitReceipt } from '../plugins/herdr-core/receipt.ts';
import type { Turn } from '../plugins/herdr-core/types.ts';
const fixture=path.join(import.meta.dirname,'fixtures/fake-hc.mjs');
function setup(flags:Record<string,unknown>={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'aal-herdr-'));const cwd=path.join(dir,'project');mkdirSync(cwd);const home=path.join(dir,'home');mkdirSync(path.join(home,'herdr'),{recursive:true});
  const state=path.join(dir,'hc.json');writeFileSync(state,JSON.stringify(flags));
  writeFileSync(path.join(home,'herdr','profiles.json'),JSON.stringify({profiles:{developer:{template:'aal-codex',access:'edit',hc:[process.execPath,fixture,'--state',state],session:'autoloop',rpcTimeoutMs:1000,turnTimeoutMs:120,monitorIntervalMs:20}}}));
  const privateDir=path.join(home,'worker','runs','1');mkdirSync(privateDir,{recursive:true});writeFileSync(path.join(privateDir,'entry.json'),JSON.stringify({token:'SECRET_HUB_RUN_TOKEN'}));
  const contextFile=path.join(privateDir,'context.json');writeFileSync(contextFile,JSON.stringify({events:[{detail:'外部资料'}]}));
  const turn:Turn={prompt:'完成这个任务。',session:'session-one',resume:null,cwd,access:'edit',contextFile,folder:privateDir,options:{profile:'developer'},execution:{run:1,attempt:1,turn:1}};
  const previous=process.env.AGENT_AUTOLOOP_HOME;process.env.AGENT_AUTOLOOP_HOME=home;
  return {dir,home,cwd,state,turn,read:()=>JSON.parse(readFileSync(state,'utf8')),set:(patch:Record<string,unknown>)=>writeFileSync(state,JSON.stringify({...JSON.parse(readFileSync(state,'utf8')),...patch})),calls:()=>readFileSync(`${state}.calls`,'utf8').trim().split('\n').map(x=>JSON.parse(x)),close:()=>{if(previous===undefined)delete process.env.AGENT_AUTOLOOP_HOME;else process.env.AGENT_AUTOLOOP_HOME=previous;rmSync(dir,{recursive:true,force:true});}};
}
test('Herdr receipt completes once and resume updates context without recreating the terminal',async()=>{
  const f=setup({usage:{input:7,output:4}});try {
    const result=await runTask(f.turn);assert.equal(result.finished,true);assert.equal(result.text,'完成了测试任务');assert.deepEqual(result.usage,{input:7,output:4});
    const create=f.calls().find(c=>c.method==='terminal.run');assert.equal(create.params.keep,false);assert.equal(create.params.no_parent,true);assert.equal(create.params.no_notify,true);assert.deepEqual(create.params.env,{AGENT_AUTOLOOP_HOME:f.home});
    assert.equal(JSON.stringify(create).includes('SECRET_HUB_RUN_TOKEN'),false);assert.equal(JSON.stringify(create).includes(f.turn.folder),false);
    writeFileSync(f.turn.contextFile,JSON.stringify({answers:[{value:'第二轮答案'}]}));
    const next={...f.turn,resume:f.turn.session,execution:{run:2,attempt:1,turn:1}};const second=await runTask(next);assert.equal(second.finished,true);
    assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);assert.equal(f.calls().filter(c=>c.method==='terminal.send').length,1);
    const inbox=path.join(f.home,'herdr','inbox');const dirs=readdirSync(inbox);assert.equal(dirs.length,2);assert(dirs.some(d=>readFileSync(path.join(inbox,d,'context.json'),'utf8').includes('第二轮答案')));
    assert.equal((await recoverTask(next)).text,second.text);
  }finally{f.close();}
});
test('Herdr validates local profile and exact access before any dispatch',async()=>{
 const f=setup();try{assert.throws(()=>prepareTask({...f.turn,access:'full'}),/权限|access/);assert.throws(()=>prepareTask({...f.turn,options:{profile:'missing'}}),/profile|配置/);assert.equal(readdirSync(path.dirname(f.state)).includes('hc.json.calls'),false);}finally{f.close();}
});
test('Herdr never treats status or screen-like text as a receipt and retains directory occupancy',async()=>{
 const f=setup({autoReceipt:false});try {
  const result=await runTask(f.turn);assert.equal(result.finished,undefined);assert.equal(result.state,'uncertain');
  const other=await runTask({...f.turn,session:'session-two',execution:{run:2,attempt:1,turn:1}});assert.equal(other.finished,undefined);assert.equal(other.state,'uncertain');
  assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);assert.equal(f.calls().filter(c=>c.method==='terminal.read').length,0);
 }finally{f.close();}
});
test('Herdr recovers a lost send response from the same receipt without sending again',async()=>{
 const f=setup();try {
  assert.equal((await runTask(f.turn)).finished,true);f.set({dropAfterSend:true});
  const next={...f.turn,resume:f.turn.session,execution:{run:2,attempt:1,turn:1}};
  const result=await runTask(next);assert.equal(result.finished,undefined);assert.equal(result.state,'uncertain');
  assert.equal((await recoverTask(next)).state,'uncertain');
  const state=f.read();state.terminals[0].status={state:'working'};f.set(state);await recoverTask(next);state.terminals[0].status={state:'done'};state.terminals[0].turn++;f.set(state);
  assert.equal((await recoverTask(next)).finished,true);assert.equal(f.calls().filter(c=>c.method==='terminal.send').length,1);
 }finally{f.close();}
});
test('Herdr keeps failed first-message delivery uncertain without resending or recreating',async()=>{
 const f=setup({firstMessageFalse:true});try {
  assert.equal((await runTask(f.turn)).state,'uncertain');assert.equal((await recoverTask(f.turn)).state,'uncertain');assert.equal((await runTask(f.turn)).state,'uncertain');
  assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);assert.equal(f.calls().filter(c=>c.method==='terminal.send').length,0);
 }finally{f.close();}
});
test('Herdr cancellation confirms remote stop and rejects identity mismatch',async()=>{
 const f=setup({autoReceipt:false,killFails:true});try {
  await runTask(f.turn);assert.equal(await stopTask(f.turn,'cancel'),false);f.set({killFails:false});assert.equal(await stopTask(f.turn,'cancel'),true);
  const before=f.calls().filter(c=>c.method==='terminal.kill').length;f.set({coreId:'different-core'});assert.equal(await stopTask(f.turn,'cancel'),true);assert.equal(f.calls().filter(c=>c.method==='terminal.kill').length,before);
 }finally{f.close();}
});
test('Herdr receipt helper binds exact nonce, refuses replacement, and does not trust non-reported status',async()=>{
 const f=setup({autoReceipt:false,reported:false});try {
  const taskPath=prepareTask(f.turn);const task=JSON.parse(readFileSync(taskPath,'utf8'));const requestPath=task.requestFile;
  submitReceipt(requestPath,{text:'完成了'});assert.throws(()=>submitReceipt(requestPath,{text:'另一份回执'}),/回执|receipt/);
  const reading=await runTask(f.turn);assert.equal(reading.finished,undefined);assert.equal(reading.state,'uncertain');
 }finally{f.close();}
});

test('Herdr completed idle terminal can be stopped without destroying its receipt',async()=>{
 const f=setup();try {const before=await runTask(f.turn);assert.equal(before.finished,true);assert.equal(await stopTask(f.turn,'cancel'),true);assert.equal(f.read().terminals[0].state,'finished');assert.deepEqual(await recoverTask(f.turn),before);}finally{f.close();}
});
test('Herdr serializes concurrent observers of one task and refuses a receipt from an unchanged terminal turn',async()=>{
 const f=setup({autoReceipt:false});try {
  const [a,b]=await Promise.all([runTask(f.turn),runTask(f.turn)]);assert.equal(a.finished,undefined);assert.equal(b.finished,undefined);assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);
  const task=JSON.parse(readFileSync(prepareTask(f.turn),'utf8'));submitReceipt(task.requestFile,{text:'完成了'});
  const state=f.read();state.terminals[0].status={state:'done'};f.set(state);
  assert.equal((await recoverTask(f.turn)).finished,undefined);
  state.terminals[0].turn=1;f.set(state);const recovered=await Promise.all([recoverTask(f.turn),recoverTask(f.turn)]);assert(recovered.some(r=>r.finished===true));assert.equal(f.calls().filter(c=>c.method==='terminal.send').length,0);
 }finally{f.close();}
});
test('Herdr stop request reaches a live bridge and is confirmed before releasing occupancy',async()=>{
 const f=setup({autoReceipt:false});try {
  const profileFile=path.join(f.home,'herdr','profiles.json');const profiles=JSON.parse(readFileSync(profileFile,'utf8'));profiles.profiles.developer.turnTimeoutMs=5000;writeFileSync(profileFile,JSON.stringify(profiles));
  const pending=runTask(f.turn);for(let i=0;i<100&&!f.read().terminals?.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(await stopTask(f.turn,'cancel'),false);const result=await pending;assert.equal(result.state,'uncertain');assert.equal(await stopTask(f.turn,'cancel'),true);assert.equal(f.read().terminals[0].state,'finished');
 }finally{f.close();}
});

test('Herdr does not invent an initial turn boundary when a run reply omits first_message.turn',async()=>{
 const f=setup({noFirstTurn:true});try {assert.equal((await runTask(f.turn)).finished,undefined);assert.equal((await recoverTask(f.turn)).state,'uncertain');assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);}finally{f.close();}
});

test('Herdr reclaims only a dead observer lease and continues the same terminal after a killed bridge',async()=>{
 const f=setup({autoReceipt:false});let child:ReturnType<typeof spawn>|undefined;
 try {
  const pf=path.join(f.home,'herdr','profiles.json');const profiles=JSON.parse(readFileSync(pf,'utf8'));profiles.profiles.developer.turnTimeoutMs=10000;writeFileSync(pf,JSON.stringify(profiles));
  const file=prepareTask(f.turn);child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',path.join(import.meta.dirname,'../plugins/herdr-core/bridge.ts'),file],{stdio:'ignore'});
  for(let i=0;i<100&&JSON.parse(readFileSync(file,'utf8')).phase!=='observing';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(JSON.parse(readFileSync(file,'utf8')).phase,'observing');const closed=once(child,'exit');child.kill('SIGKILL');await closed;
  assert.equal((await recoverTask(f.turn)).state,'running');
  const task=JSON.parse(readFileSync(file,'utf8'));submitReceipt(task.requestFile,{text:'业务已经完成，只恢复结果'});const state=f.read();state.terminals[0].status={state:'done'};state.terminals[0].turn++;f.set(state);
  assert.equal((await recoverTask(f.turn)).text,'业务已经完成，只恢复结果');assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,1);assert.equal(f.calls().filter(c=>c.method==='terminal.send').length,0);
  f.set({autoReceipt:true});assert.equal((await runTask({...f.turn,resume:f.turn.session,execution:{run:2,attempt:1,turn:1}})).finished,true);
 }finally{child?.kill('SIGKILL');f.close();}
});
test('Herdr never sends or kills when the core identity changed beneath a pending execution',async()=>{
 const f=setup({autoReceipt:false});try{
  await runTask(f.turn);f.set({coreId:'new-core'});assert.equal((await recoverTask(f.turn)).state,'uncertain');assert.equal(await stopTask(f.turn,'cancel'),false);assert.equal(f.calls().filter(c=>c.method==='terminal.kill').length,0);
 }finally{f.close();}
});

test('Herdr rejects a request file changed after dispatch even when a receipt copies its new nonce',async()=>{
 const f=setup({autoReceipt:false});try{
  await runTask(f.turn);const task=JSON.parse(readFileSync(prepareTask(f.turn),'utf8'));const req=JSON.parse(readFileSync(task.requestFile,'utf8'));req.nonce='a-different-nonce-that-is-long-enough';writeFileSync(task.requestFile,JSON.stringify(req));submitReceipt(task.requestFile,{text:'不应采纳'});
  const state=f.read();state.terminals[0].status={state:'done'};state.terminals[0].turn++;f.set(state);const recovered=await recoverTask(f.turn);assert.equal(recovered.finished,undefined);assert.equal(recovered.state,'uncertain');
 }finally{f.close();}
});

test('Herdr reports safe pre-dispatch failure as finished but keeps conflicts with a live execution uncertain',async()=>{
 const f=setup({noTemplate:true});try{
  const safe=await runTask(f.turn);assert.equal(safe.finished,true);assert.match(safe.error!,/template/);assert.equal((await recoverTask(f.turn)).finished,true);assert.equal(f.calls().filter(c=>c.method==='terminal.run').length,0);
  f.set({noTemplate:false,autoReceipt:false});const active={...f.turn,execution:{run:2,attempt:1,turn:1}};await runTask(active);const changed=await runTask({...active,prompt:'发生变化的提示词'});assert.equal(changed.finished,undefined);assert.equal(changed.state,'uncertain');
 }finally{f.close();}
});
