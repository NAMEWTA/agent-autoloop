import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { prepareTask, preparationFailure, recoverTask, stopTask } from './task.ts';
import { profileFor } from './store.ts';
import { control } from './control.ts';
import type { Reading, Turn } from './types.ts';
function executable(program:string){const candidates=program.includes('/')?[path.resolve(program)]:(process.env.PATH ?? '').split(path.delimiter).map(p=>path.join(p,program));return candidates.some(p=>{try{accessSync(p,constants.X_OK);return true;}catch{return false;}});}
export default {
 capabilities:{resume:true,persistent:true},
 command(turn:Turn):string[]{const argv=[process.execPath,'--disable-warning=ExperimentalWarning',path.join(import.meta.dirname,'bridge.ts')];try{return [...argv,prepareTask(turn)];}catch(e){return [...argv,'--reading',JSON.stringify(preparationFailure(turn,e))];}},
 read(stdout:string,code:number|null,_stderr:string):Reading{
  let last:Reading|undefined;
  for(const line of stdout.split('\n')){if(!line.trim())continue;try{const r=JSON.parse(line) as Reading;if(r&&typeof r==='object'&&(r.finished===true||r.state==='running'||r.state==='uncertain'||typeof r.error==='string'))last=r;}catch{}}
  if(last?.finished===true&&typeof last.text==='string'&&last.text.trim()&&!last.state)return last;
  if(last?.state)return {...last,finished:undefined};
  if(last?.error&&code!==null)return last;
  return {state:code===null?'running':'uncertain',error:code===null?undefined:'Herdr 观察进程已结束，仍需核实持久化回执'};
 },
 recover:recoverTask,stop:stopTask,control,
 check(configuration?:Record<string,unknown>):string|null{try{const {profile}=profileFor(configuration);if(!executable(profile.hc[0]))return `找不到 Herdr 可执行文件 ${profile.hc[0]}`;return null;}catch(e){return (e as Error).message;}},
};
