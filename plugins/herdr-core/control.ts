import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomic, bindingFile, bindings, home, readBinding, readJSON, taskFile } from './store.ts';
import { stopTaskById } from './task.ts';
import { handshake, Rpc } from './rpc.ts';
import type { Task, Terminal } from './types.ts';
export async function control(args:string[]):Promise<unknown>{
 const [command,session]=args;
 if(command==='list')return {sessions:bindings().map(b=>readBinding({home:home(),session:b.session}) ?? b)};
 if(!session||!['inspect','pause','resume','stop'].includes(command))throw Error('用法：plugin herdr-core list | inspect/pause/resume/stop <session>');
 const binding=readBinding({home:home(),session});if(!binding)throw Error('找不到这个 Herdr session');
 if(command==='pause'||command==='resume'){const paused=command==='pause';atomic(`${bindingFile(home(),session)}.paused`,{paused});return {session,paused,note:paused?'已暂停之后的新消息；正在执行的原生任务不会因此停止':'已恢复之后的新消息；不重发尚未确认的请求'};}
 if(command==='stop'){
  if(binding.stopped)return {session,stopped:true,stopRequested:false,note:'这个终端已确认停止'};
  const task=readJSON<Task>(taskFile(home(),binding.activeTask ?? binding.lastTask));const stopped=await stopTaskById(home(),task.id);
  return {session,stopped,stopRequested:binding.activeTask!==null,run:task.execution.run,attempt:task.execution.attempt,note:stopped?'已确认原生终端停止；此操作不结算中台业务。活动业务请用 recover <顶层轮次ID> --stop':'已请求停止；此操作不结算中台业务。活动业务请用 recover <顶层轮次ID> --stop'};
 }
 const file=taskFile(home(),binding.activeTask ?? binding.lastTask);if(!existsSync(file))return {binding,error:'持久化执行记录缺失'};
 const task=readJSON<Task>(file);const rpc=new Rpc(task.profile);
 try{const hello=await handshake(rpc);if(hello.core.id!==binding.coreId)throw Error('Herdr core 身份已经改变');const terminal=await rpc.call<Terminal>('terminal.get',{terminal:binding.terminal});return {binding,attach:{argv:[...task.profile.hc,'attach',binding.terminal],env:{HC_SESSION:task.profile.session}},execution:{run:task.execution.run,attempt:task.execution.attempt,turn:task.execution.turn,phase:task.phase,note:task.note},terminal};}finally{rpc.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{process.stdout.write(JSON.stringify(await control(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(`${(e as Error).message}\n`);process.exitCode=1;}}
