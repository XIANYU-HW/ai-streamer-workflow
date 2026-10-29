'use strict';
const fs=require('node:fs'),path=require('node:path');
const APP_NAME='AiStreamerStudioPublic',APP_ID='local.ai-streamer.studio.public';
const MARKER='.ai-streamer-studio-public.json';
const denied=new Set(['characterstudio','programmehost','角色工作室']);
function safePath(value){
 if(typeof value!=='string'||!path.isAbsolute(value))throw Error('Data directory must be an absolute path.');
 const resolved=path.resolve(value);
 if(resolved.split(path.sep).some(part=>denied.has(part.toLowerCase())))throw Error('Legacy application data directories are not permitted.');
 if(!/^AiStreamerStudioPublic(?:-[A-Za-z0-9._-]+)?$/.test(path.basename(resolved)))throw Error('Choose a new AiStreamerStudioPublic or AiStreamerStudioPublic-* data directory.');
 let probe=resolved,tail=[];
 while(!fs.existsSync(probe)){tail.unshift(path.basename(probe));const parent=path.dirname(probe);if(parent===probe)break;probe=parent;}
 const actual=path.join(fs.realpathSync(probe),...tail);
 if(actual.split(path.sep).some(part=>denied.has(part.toLowerCase())))throw Error('Legacy application data aliases are not permitted.');
 if(fs.existsSync(resolved)&&fs.lstatSync(resolved).isSymbolicLink())throw Error('Data directory must not be a symbolic link.');
 return actual;
}
function resolveDataDirectory({appData,override}={}){return safePath(override||path.join(appData,APP_NAME));}
function prepareDataDirectory(directory){
 const target=safePath(directory);fs.mkdirSync(target,{recursive:true,mode:0o700});
 if(!fs.lstatSync(target).isDirectory())throw Error('Data directory is not a directory.');
 const marker=path.join(target,MARKER),names=fs.readdirSync(target);
 if(!names.includes(MARKER)){
  if(names.length)throw Error('Existing unmarked data is preserved. Choose a new empty public data directory.');
  fs.writeFileSync(marker,JSON.stringify({application:APP_ID,version:1})+'\n',{flag:'wx',mode:0o600});
 }else{
  const st=fs.lstatSync(marker);if(!st.isFile()||st.isSymbolicLink()||st.size>1024)throw Error('Invalid public data marker.');
  const record=JSON.parse(fs.readFileSync(marker,'utf8'));if(record.application!==APP_ID||record.version!==1)throw Error('This data belongs to another application.');
 }
 return target;
}
module.exports={APP_NAME,APP_ID,MARKER,resolveDataDirectory,prepareDataDirectory};
