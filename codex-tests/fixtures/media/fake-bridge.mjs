import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
export function serveBridge(prefix) {
 const dir=process.env.MEDIA_FIXTURE_DIR;if(!dir)throw new Error('Fixture environment required');
 const schemas=JSON.parse(fs.readFileSync(new URL('./bridge-tools.json',import.meta.url)))[prefix];
 const stateFile=path.join(dir,`${prefix}-remote.json`);
 const config=()=>JSON.parse(fs.readFileSync(path.join(dir,'scenario.json')));
 const read=()=>JSON.parse(fs.readFileSync(stateFile));const save=j=>fs.writeFileSync(stateFile,JSON.stringify(j));
 const log=(name,args)=>fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({name,args})+'\n');
 const source=()=>path.join(path.dirname(fileURLToPath(import.meta.url)),config().source||'sample.wav');
 const complete=j=>{
  const s=config(); if(s.ready===false)return j;
  const kind=j.payload.mode;
  let message={role:'assistant',message_id:'bound-output',images:[],media:[]};
  for(let i=0;i<(s.candidates||1);i++){
   if(kind==='image')message.images.push({image_index:i,width:32,height:32,asset_id:'im'+i});
   else message.media.push({media_index:i,kind:kind==='video'||s.cover_video?'video':'audio',ready:true,is_music:kind==='music'&&!s.not_music,asset_id:'av'+i,duration_seconds:0.5});
  }
  if(s.thumbnail_only)message={...message,images:[{image_index:0,width:32,height:32}],media:[]};
  return {...j,status:s.remote_status||'succeeded',phase:'completed',result:{messages:[message],completion_evidence:'fixture bound turn'},progress:{observation_stale:s.stale||false}};
 };
 const loop=readline.createInterface({input:process.stdin});
 loop.on('line',line=>{
  const q=JSON.parse(line);if(q.id===undefined)return;
  let result;
  if(q.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:schemas.info,capabilities:{tools:{}}};
  else if(q.method==='tools/list')result={tools:schemas.tools};
  else if(q.method==='tools/call'){
   const n=q.params.name,a=q.params.arguments;log(n,a);let data;let isError=false;
   if(n==='bridge_status')data={connected:config().offline!==true,input_dir:path.join(dir,'input'),storage_fault:null};
   else if(n.startsWith(prefix+'_generate_')){
    if(config().deny_submit){data={error:{code:'QUOTA_LIMIT',message:'Fixture account limit'}};isError=true;}
    else{data={id:'a'.repeat(32),request_id:a.request_id,payload:{...a,mode:n.split('_').at(-1)},tab_id:17,status:'queued',phase:'queued',may_have_submitted:true};save(data);if(config().drop_submit)process.exit(0);}
   }else if(n===prefix+'_jobs')data={jobs:fs.existsSync(stateFile)?[read()]:[]};
   else if(n===prefix+'_job'||n===prefix+'_resync'){data=complete(read());if(config().wrong_binding)data.request_id='wrong';if(config().wrong_prompt)data.payload={...data.payload,prompt:'another task'};}
   else if(n===prefix+'_cancel_job'){data={...read(),status:'cancelled',result:{website_stop_confirmed:config().stop_confirmed===true}};save(data);}
   else if(n===prefix+'_download_image'||n===prefix+'_download_media'){
    const file=path.join(dir,'download'+path.extname(source()));fs.copyFileSync(source(),file);
    fs.writeFileSync(path.join(dir,'download.json'),JSON.stringify({file}));if(config().drop_download)process.exit(0);
    data={download_id:0,state:'in_progress'};
   }else if(n===prefix+'_download_status'){
    const d=JSON.parse(fs.readFileSync(path.join(dir,'download.json')));
    data={download_id:0,state:config().downloading?'in_progress':'complete',filename:d.file,exists:true,bytes_received:fs.statSync(d.file).size,mime:config().cover_video?'video/mp4':'audio/wav',danger:'safe',mime_matches_expected:true};
   }else{data={error:{code:'UNKNOWN_TOOL',message:n}};isError=true;}
   result={structuredContent:{data},content:[{type:'text',text:JSON.stringify(data)}],isError};
  }else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
 });
}
