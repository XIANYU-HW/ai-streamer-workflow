'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function writeRuntimeAccess({directory,origin,tokens}){
 if(!path.isAbsolute(directory)||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)||Number(origin.split(':').at(-1))>65535||!tokens||Object.keys(tokens).length!==3||!['control','producer','monitor'].every(k=>/^[0-9a-f]{64}$/.test(tokens[k]))||new Set(Object.values(tokens)).size!==3)throw new Error('Invalid runtime capability configuration');
 await fs.mkdir(directory,{recursive:true,mode:0o700});const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('Invalid runtime directory');
 const target=path.join(directory,'runtime-access.json'),temp=path.join(directory,'.runtime-access-'+crypto.randomUUID()+'.tmp');
 try{const old=await fs.lstat(target);if(!old.isFile()||old.isSymbolicLink())throw new Error('Invalid runtime descriptor');}catch(e){if(e.code!=='ENOENT')throw e;}
 try{await fs.writeFile(temp,JSON.stringify({schema_version:1,boot_id:crypto.randomUUID(),origin,tokens,created_at:new Date().toISOString(),transport:'loopback-http-scoped',expires:'application_exit'},null,2),{flag:'wx',mode:0o600});await fs.rename(temp,target);await fs.chmod(target,0o600);}finally{await fs.unlink(temp).catch(()=>{});}
 const created=await fs.stat(target);return {path:target,async close(){try{const current=await fs.lstat(target);if(current.isFile()&&!current.isSymbolicLink()&&created.ino!==0&&current.ino===created.ino&&current.dev===created.dev)await fs.unlink(target);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
module.exports={writeRuntimeAccess};
