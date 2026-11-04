import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Profile } from './types.ts';
export class Rpc {
 child:ChildProcessWithoutNullStreams; pending=new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();next=0;buffer='';ended=false;onEvent?:()=>void;stderr='';
 constructor(readonlyProfile: Profile) {
  this.profile=readonlyProfile;
  const env={...process.env};for(const key of Object.keys(env))if(/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$)|HC_TERMINAL_ID$)/.test(key))delete env[key];
  this.child=spawn(readonlyProfile.hc[0], [...readonlyProfile.hc.slice(1),'connect','--session',readonlyProfile.session],{env,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b).slice(-1000);});
  this.child.stdout.on('data',b=>{this.buffer+=b.toString();if(this.buffer.length>4*1024*1024){this.fail(Error('Herdr RPC 消息过长'));this.close();return;}let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);this.line(line);}});
  this.child.on('error',e=>this.fail(e));this.child.on('close',()=>this.fail(Error(`Herdr 连接中断${this.stderr?`：${this.stderr.trim()}`:''}`)));
 }
 profile:Profile;
 private line(line:string){if(!line.trim())return;let m;try{m=JSON.parse(line);}catch{this.fail(Error('Herdr 返回了无效 JSON-RPC'));this.close();return;}if(m.id===undefined){this.onEvent?.();return;}const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(Error(`Herdr ${m.error.data?.kind ?? m.error.message ?? 'RPC 失败'}`));else p.resolve(m.result);}
 private fail(e:Error){this.ended=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
 call<T=any>(method:string,params:Record<string,unknown>={},timeout=this.profile.rpcTimeoutMs):Promise<T>{if(this.ended)return Promise.reject(Error('Herdr 连接已结束'));return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Herdr ${method} 响应超时；投递是否发生尚未确定`));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',e=>{if(e){const p=this.pending.get(id);if(p){clearTimeout(timer);this.pending.delete(id);reject(e);}}});});}
 close(){this.fail(Error('Herdr 连接已关闭'));this.child.stdin.destroy();this.child.stdout.destroy();this.child.stderr.destroy();this.child.kill('SIGTERM');}
}
export async function handshake(rpc:Rpc){const h=await rpc.call<{generation:number;core:{id:string};methods:string[]}>('hello',{generation:1});if(h.generation!==1||typeof h.core?.id!=='string'||!h.core.id||!Array.isArray(h.methods))throw Error('Herdr 协议版本或 core 身份不受支持');for(const m of ['templates.list','terminal.run','terminal.send','terminal.get','terminal.list','terminal.kill'])if(!h.methods.includes(m))throw Error(`Herdr 缺少必要能力 ${m}`);return h;}
