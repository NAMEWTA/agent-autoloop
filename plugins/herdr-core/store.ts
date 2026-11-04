import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Binding, Profile, Task, Turn } from './types.ts';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const home = () => path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), '.agent-autoloop'));
export function directory(p: string) { mkdirSync(p, { recursive: true, mode: 0o700 }); return p; }
export function readJSON<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }
export function syncDirectory(dir: string) { const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);} }
export function atomic(file: string, data: unknown) {
  directory(path.dirname(file)); const tmp=`${file}.${randomUUID()}.tmp`;const fd=openSync(tmp,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(data)+'\n');fsyncSync(fd); } finally {closeSync(fd);}
  renameSync(tmp,file);syncDirectory(path.dirname(file));
}
const integer=(v:unknown,fallback:number,min:number,max:number)=>{if(v===undefined)return fallback;if(typeof v!=='number'||!Number.isInteger(v)||v<min||v>max)throw Error('Herdr 配置中的超时或轮询间隔无效');return v;};
export function profileFor(options?: Record<string,unknown>, access?: string, cwd?: string) {
 const name=options?.profile;if(typeof name!=='string'||!name||name.length>128)throw Error('请配置 agent.options.profile，指向本机 Herdr profile');
 const config=readJSON<{profiles?:Record<string,unknown>}>(path.join(home(),'herdr','profiles.json'));const raw=config.profiles?.[name];
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error(`找不到 Herdr profile 配置：${name}`);
 const p=raw as Record<string,unknown>;
 if(typeof p.template!=='string'||!p.template.trim()||!['read','edit','full'].includes(String(p.access)))throw Error('Herdr profile 必须填写 template 和 access');
 if(access!==undefined&&p.access!==access)throw Error(`Herdr profile 权限 ${p.access} 与规则 ${access} 不匹配`);
 const hc=p.hc ?? ['hc'];if(!Array.isArray(hc)||hc.length===0||hc.some(s=>typeof s!=='string'||!s||s.includes('\0')))throw Error('Herdr profile.hc 必须是非空命令数组');
 const session=p.session ?? 'autoloop';if(typeof session!=='string'||!session||session.includes('\0'))throw Error('Herdr profile.session 无效');
 const profile:Profile={template:p.template,access:p.access as Profile['access'],hc:hc as string[],session,rpcTimeoutMs:integer(p.rpcTimeoutMs,15000,50,600000),turnTimeoutMs:integer(p.turnTimeoutMs,10800000,50,86400000),monitorIntervalMs:integer(p.monitorIntervalMs,1000,20,30000)};
 if(p.cwd!==undefined){if(typeof p.cwd!=='string')throw Error('Herdr profile.cwd 无效');profile.cwd=realpathSync(p.cwd);if(cwd&&profile.cwd!==realpathSync(cwd))throw Error('工作目录与 Herdr profile.cwd 不匹配');}
 return {name,profile,fingerprint:digest(JSON.stringify(profile))};
}
export const taskFile=(h:string,id:string)=>path.join(h,'herdr','tasks',`${id}.json`);
export const bindingFile=(h:string,session:string)=>path.join(h,'herdr','sessions',`${digest(session)}.json`);
export function readBinding(task:Pick<Task,'home'|'session'>):Binding|null {const file=bindingFile(task.home,task.session);if(!existsSync(file))return null;const b=readJSON<Binding>(file);const paused=`${file}.paused`;if(existsSync(paused))b.paused=readJSON<{paused:boolean}>(paused).paused;return b;}
export function saveBinding(task:Pick<Task,'home'|'session'>,binding:Binding){atomic(bindingFile(task.home,task.session),binding);}
export function saveTask(task:Task){task.updatedAt=Date.now();atomic(taskFile(task.home,task.id),task);}
export function taskIdentity(turn:Turn) {
 const execution=turn.execution;if(!execution||Object.values(execution).length!==3||!['run','attempt','turn'].every(k=>Number.isSafeInteger(execution[k as keyof typeof execution])&&execution[k as keyof typeof execution]>0))throw Error('Herdr 执行缺少稳定的 run/attempt/turn 编号');
 const session=turn.resume ?? turn.session;if(typeof session!=='string'||!session||session.length>512)throw Error('Herdr session 无效');
 return {session,execution,id:digest(JSON.stringify([session,execution.run,execution.attempt,execution.turn]))};
}
export function taskFor(turn:Turn):Task|null {const {id}=taskIdentity(turn);const file=taskFile(home(),id);return existsSync(file)?readJSON<Task>(file):null;}
export function bindings():Binding[]{const dir=path.join(home(),'herdr','sessions');if(!existsSync(dir))return [];return readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>readJSON<Binding>(path.join(dir,f)));}
const lockPaths=(task:Task)=>[path.join(task.home,'herdr','locks',`cwd-${digest(task.cwd)}.lock`),path.join(task.home,'herdr','locks',`session-${digest(task.session)}.lock`)];
type Owner={task:string;pid:number;nonce:string};
const alive=(pid:number)=>{if(pid===0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
// The reaper is a separate exclusive mkdir. Contenders cannot both replace a dead lease.
// A crash inside the tiny reaper section fails closed and requires operator inspection.
function lease(dir:string,task:string):()=>void {
 const lock=path.join(dir,'lease');const reaper=path.join(dir,'reaper');const nonce=randomUUID();
 const claim=()=>{mkdirSync(lock,{mode:0o700});atomic(path.join(lock,'owner.json'),{task,pid:process.pid,nonce});};
 try{claim();}catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  try{mkdirSync(reaper,{mode:0o700});}catch{throw Error('Herdr 执行锁正在恢复，请稍后核实');}
  try{const old=readJSON<Owner>(path.join(lock,'owner.json'));if(alive(old.pid))throw Error('这个会话或工作目录正在被其他接单进程核实');rmSync(lock,{recursive:true});claim();}finally{rmSync(reaper,{recursive:true});}
 }
 return ()=>{if(!existsSync(lock))return;const o=readJSON<Owner>(path.join(lock,'owner.json'));if(o.nonce===nonce)rmSync(lock,{recursive:true});};
}
export function acquire(task:Task) {
 const acquired:{dir:string;release:()=>void;fresh:boolean}[]=[];
 try {
  for(const dir of lockPaths(task)) {
   directory(path.dirname(dir));let fresh=false;
   try{mkdirSync(dir,{mode:0o700});fresh=true;atomic(path.join(dir,'owner.json'),{task:task.id,pid:0,nonce:''});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   const owner=readJSON<Owner>(path.join(dir,'owner.json'));if(owner.task!==task.id)throw Error('这个会话或工作目录仍有未确认结束的任务');
   const release=lease(dir,task.id);if(readJSON<Owner>(path.join(dir,'owner.json')).task!==task.id){release();throw Error('Herdr 目录占用已发生变化');}acquired.push({dir,release,fresh});
  }
 }catch(e){for(const item of acquired.reverse()){if(item.fresh)rmSync(item.dir,{recursive:true});else item.release();}throw e;}
 return (release:boolean)=>{for(const item of acquired.reverse()){if(release&&existsSync(item.dir)){const o=readJSON<Owner>(path.join(item.dir,'owner.json'));if(o.task===task.id)rmSync(item.dir,{recursive:true});else item.release();}else item.release();}};
}
export function prepareGuard(id:string):()=>void {const dir=directory(path.join(home(),'herdr','preparing',id));return lease(dir,id);}
