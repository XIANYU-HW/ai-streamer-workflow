'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'public-studio-smoke-'));
try{
 const binary=process.env.AI_STREAMER_ELECTRON_BINARY||require('electron');
 const result=spawnSync(binary,[root,'--public-smoke'],{encoding:'utf8',timeout:35000,env:{...process.env,AI_STREAMER_STUDIO_DATA_DIR:path.join(temp,'AiStreamerStudioPublic-smoke'),ELECTRON_RUN_AS_NODE:''}});
 const marker=result.stdout?.split('\n').find(line=>line.startsWith('PUBLIC_STUDIO_SMOKE '));
 if(result.status!==0||!marker){process.stderr.write(result.stderr||'No isolated smoke receipt.\n');throw Error('Isolated smoke failed; no live workflow was started.');}
 console.log(marker);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
