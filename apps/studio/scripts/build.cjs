'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json'),platform=process.argv[2];
if(!['darwin','win32'].includes(platform)||platform!==process.platform)throw Error('Build on the requested target OS. Cross-platform packages are not claimed tested.');
const binary=require('electron'),dist=path.resolve(path.dirname(require.resolve('electron/package.json')),'dist'),out=path.join(root,'dist',pkg.productName+'-'+platform+'-'+process.arch);
if(fs.existsSync(out))throw Error('Build destination exists; choose a fresh build directory.');
let resources;
if(platform==='darwin'){
 const app=path.join(out,pkg.productName+'.app');fs.mkdirSync(out,{recursive:true});fs.cpSync(path.join(dist,'Electron.app'),app,{recursive:true});resources=path.join(app,'Contents','Resources');
 const plist=path.join(app,'Contents','Info.plist');
 for(const [key,value]of [['CFBundleName',pkg.productName],['CFBundleDisplayName',pkg.productName],['CFBundleIdentifier','local.ai-streamer.studio.public'],['CFBundleShortVersionString',pkg.version]]){const r=spawnSync('/usr/libexec/PlistBuddy',['-c','Set :'+key+' '+value,plist],{encoding:'utf8'});if(r.status!==0)throw Error('Could not set bundle identity.');}
}else{fs.cpSync(dist,out,{recursive:true});fs.renameSync(path.join(out,path.basename(binary)),path.join(out,pkg.productName+'.exe'));resources=path.join(out,'resources');}
const target=path.join(resources,'app');fs.mkdirSync(target,{recursive:true});
for(const name of fs.readdirSync(root))if(name.endsWith('.cjs')||name==='package.json')fs.copyFileSync(path.join(root,name),path.join(target,name));
fs.cpSync(path.join(root,'renderer'),path.join(target,'renderer'),{recursive:true});
for(const name of ['LICENSE','LICENSES.chromium.html'])if(fs.existsSync(path.join(dist,name)))fs.copyFileSync(path.join(dist,name),path.join(out,name));
console.log('Local unsigned build created: '+path.relative(root,out));
console.log('No application launched. Signing, notarization and target-device testing remain separate.');
