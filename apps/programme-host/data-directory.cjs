'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const APP='AiStreamerProgrammePublic',MARKER='.public-programme-owner.json';
const forbidden=new Set(['characterstudio','programmehost','aistreamerstudiopublic','角色工作室']);
function resolveDataDirectory(appData,override,pathAPI=path){
 if(typeof appData!=='string'||!pathAPI.isAbsolute(appData))throw Error('APP_DATA_PATH_INVALID');
 if(override!==undefined&&override!==null&&(typeof override!=='string'||!pathAPI.isAbsolute(override)))throw Error('ABSOLUTE_DATA_DIRECTORY_REQUIRED');
 const dir=pathAPI.resolve(override||pathAPI.join(appData,APP));
 if(dir===pathAPI.parse(dir).root||dir.startsWith('\\\\'))throw Error('PRIVATE_LOCAL_DATA_DIRECTORY_REQUIRED');
 if(dir.split(/[\\/]+/).some(part=>forbidden.has(part.replace(/[. ]+$/g,'').toLowerCase())))throw Error('LEGACY_OR_OTHER_APP_DIRECTORY_FORBIDDEN');
 return dir;
}
function ensureDataDirectory(directory){
 const dir=resolveDataDirectory(path.dirname(directory),directory);
 for(let p=dir;p!==path.dirname(p);p=path.dirname(p)){
  try{const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isDirectory())throw Error('DATA_DIRECTORY_ALIAS_FORBIDDEN');}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const marker=path.join(dir,MARKER);
 if(fs.existsSync(dir)){
  if(fs.existsSync(marker)){
   const s=fs.lstatSync(marker);if(s.isSymbolicLink()||!s.isFile()||s.size>256)throw Error('DATA_OWNER_MARKER_INVALID');
   const value=JSON.parse(fs.readFileSync(marker,'utf8'));
   if(value.app!==APP||value.schema_version!==1||Object.keys(value).length!==2)throw Error('DATA_OWNER_MARKER_INVALID');
  }else if(fs.readdirSync(dir).length)throw Error('FOREIGN_DATA_DIRECTORY_NOT_EMPTY');
 }
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(!fs.existsSync(marker))fs.writeFileSync(marker,JSON.stringify({app:APP,schema_version:1})+'\n',{flag:'wx',mode:0o600});
 for(const [name,directory] of [['Session',true],['status.json',false]]){
  try{const stat=fs.lstatSync(path.join(dir,name));if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()))throw Error('MANAGED_DATA_ALIAS_FORBIDDEN');}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return dir;
}
function writeStatus(directory,value){
 const dir=ensureDataDirectory(directory),file=path.join(dir,'status.json'),temporary=path.join(dir,'.status-'+crypto.randomUUID()+'.tmp');let fd=null,created=false;
 try{fd=fs.openSync(temporary,'wx',0o600);created=true;fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.closeSync(fd);fd=null;fs.renameSync(temporary,file);}
 finally{if(fd!==null)fs.closeSync(fd);if(created)try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
module.exports={APP,resolveDataDirectory,ensureDataDirectory,writeStatus};
