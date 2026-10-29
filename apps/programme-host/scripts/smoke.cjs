'use strict';
// Explicit developer-only smoke; uses a fresh temporary profile and hidden renderer.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ai-streamer-programme-smoke-'));
try{
 const executable=process.env.AI_STREAMER_ELECTRON_BINARY||process.env.AI_STREAMER_ELECTRON_EXECUTABLE||require('electron');
 if(!path.isAbsolute(executable))throw Error('ABSOLUTE_ELECTRON_EXECUTABLE_REQUIRED');
 const env={...process.env,AI_STREAMER_PROGRAMME_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 const output=execFileSync(executable,[root,'--smoke-test'],{env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 const result=output.trim().split('\n').map(s=>{try{return JSON.parse(s);}catch{return null;}}).find(x=>x?.isolated_offscreen===true);
 if(!result||!result.empty_screen||!result.audio_muted||result.remote_requests!==0)throw Error('SMOKE_RESULT_INVALID');
 console.log(JSON.stringify(result));
}finally{fs.rmSync(profile,{recursive:true,force:true});}
