'use strict';
// Packaging only: uses a pristine installed Electron runtime and never launches it.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--platform'||!['darwin','win32'].includes(args[1]))throw Error('USE_BUILD_MAC_OR_BUILD_WIN');
const platform=args[1],runtime=process.env.AI_STREAMER_ELECTRON_DIST||path.join(path.dirname(require.resolve('electron/package.json')),'dist');
if(!path.isAbsolute(runtime))throw Error('ABSOLUTE_PRISTINE_RUNTIME_REQUIRED');
const version=fs.readFileSync(path.join(runtime,'version'),'utf8').trim();if(version!==pkg.devDependencies.electron)throw Error('ELECTRON_VERSION_MISMATCH');
const output=path.join(root,'dist',`AiStreamerProgramme-${pkg.version}-${platform}`);if(fs.existsSync(output))throw Error('BUILD_OUTPUT_EXISTS_MOVE_IT_BEFORE_REBUILD');
if(platform==='darwin'&&process.platform!=='darwin')throw Error('MAC_PACKAGING_REQUIRES_MACOS');
const mainExecutable=path.join(runtime,platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron.exe');if(!fs.statSync(mainExecutable).isFile())throw Error('REQUESTED_RUNTIME_PLATFORM_NOT_INSTALLED');
for(const name of ['LICENSE','LICENSES.chromium.html'])if(!fs.statSync(path.join(runtime,name)).isFile())throw Error('UPSTREAM_LICENSE_FILES_REQUIRED');
fs.mkdirSync(output,{recursive:true});
const payload=['main.cjs','policy.cjs','data-directory.cjs','offline.html'];
function install(resources){
 for(const name of ['app','app.asar','default_app.asar'])fs.rmSync(path.join(resources,name),{recursive:true,force:true});
 const app=path.join(resources,'app');fs.mkdirSync(app,{recursive:true});
 for(const name of payload)fs.copyFileSync(path.join(root,name),path.join(app,name));
 fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,main:pkg.main,license:pkg.license},null,2)+'\n');
}
if(platform==='darwin'){
 const app=path.join(output,'AI Streamer Programme.app');fs.cpSync(path.join(runtime,'Electron.app'),app,{recursive:true,dereference:false,verbatimSymlinks:true});
 const plist=path.join(app,'Contents/Info.plist'),name='AiStreamerProgramme';
 fs.renameSync(path.join(app,'Contents/MacOS/Electron'),path.join(app,'Contents/MacOS',name));
 for(const [key,value] of Object.entries({CFBundleExecutable:name,CFBundleName:'AI Streamer Programme',CFBundleDisplayName:'AI Streamer Programme',CFBundleIdentifier:'org.ai-streamer.programme.public',CFBundleShortVersionString:pkg.version,CFBundleVersion:pkg.version})){
  try{execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);}catch{execFileSync('/usr/libexec/PlistBuddy',['-c',`Add :${key} string ${value}`,plist]);}
 }
 const frameworks=path.join(app,'Contents/Frameworks');
 for(const name of fs.readdirSync(frameworks).filter(n=>n.endsWith('.app'))){
  const helper=path.join(frameworks,name,'Contents/Info.plist'),suffix=name.toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/\.$/,'');
  execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :CFBundleIdentifier org.ai-streamer.programme.public.${suffix}`,helper]);
 }
 install(path.join(app,'Contents/Resources'));
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--timestamp=none',app],{stdio:'pipe'});
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
}else{
 const folder=path.join(output,'AiStreamerProgramme');fs.cpSync(runtime,folder,{recursive:true,dereference:false,verbatimSymlinks:true});
 fs.renameSync(path.join(folder,'electron.exe'),path.join(folder,'AiStreamerProgramme.exe'));install(path.join(folder,'resources'));
}
for(const name of ['LICENSE','LICENSES.chromium.html'])fs.copyFileSync(path.join(runtime,name),path.join(output,name));
fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify({version:pkg.version,electron_version:version,platform,launched:false,windows_runtime_verified:false,notarized:false,signed_by_publisher:false,payload},null,2)+'\n');
console.log(`Built ${path.relative(root,output)} without starting the application.`);
