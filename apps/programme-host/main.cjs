'use strict';
const {app,BrowserWindow,Menu,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {parseOptions,createPolicy}=require('./policy.cjs');
const {resolveDataDirectory,ensureDataDirectory,writeStatus}=require('./data-directory.cjs');
let config,dataDirectory;
try{
 config=parseOptions(process.argv.slice(app.isPackaged?1:2),process.env);
 dataDirectory=ensureDataDirectory(resolveDataDirectory(app.getPath('appData'),config.dataDirectory));
}catch{process.stderr.write('Programme window configuration or data directory was rejected.\n');app.exit(1);}
if(config&&dataDirectory){
 app.setName('AI Streamer Programme');
 if(process.platform==='win32')app.setAppUserModelId('org.ai-streamer.programme.public');
 const sessionDirectory=path.join(dataDirectory,'Session');fs.mkdirSync(sessionDirectory,{recursive:true,mode:0o700});
 app.setPath('userData',dataDirectory);app.setPath('sessionData',sessionDirectory);
 app.commandLine.appendSwitch('autoplay-policy','document-user-activation-required');app.commandLine.appendSwitch('mute-audio');
 const OFFLINE=pathToFileURL(path.join(__dirname,'offline.html')).href,policy=createPolicy(config,OFFLINE),TITLE='AI Streamer · 节目窗口';
 let window=null,retry=null,closing=false,target=config.url||OFFLINE,sequence=0,remoteRequests=0;
 function receipt(state,extra={}){
  try{writeStatus(dataDirectory,{schema_version:1,app_version:app.getVersion(),pid:process.pid,state,at_utc:new Date().toISOString(),audio_muted:true,configured_public_url:config.url,...extra});}catch{}
 }
 function clearRetry(){if(retry)clearTimeout(retry);retry=null;}
 function fit(){if(window&&!window.isDestroyed()){const [w,h]=window.getContentSize();window.webContents.setZoomFactor(Math.min(w/1920,h/1080));}}
 async function waitScreen(reason,attempt){
  if(closing||!window||window.isDestroyed()||attempt!==sequence)return;
  clearRetry();receipt('waiting',{reason});try{await window.loadURL(OFFLINE);}catch{}
  if(!closing&&attempt===sequence&&config.url&&!config.smoke)retry=setTimeout(()=>void loadTarget(),3000);
 }
 async function loadTarget(){
  if(closing||!window||window.isDestroyed())return;
  clearRetry();const attempt=++sequence;let timeout;receipt(target===OFFLINE?'empty':'loading');
  try{
   await Promise.race([window.loadURL(target),new Promise((_resolve,reject)=>{timeout=setTimeout(()=>{if(!closing&&attempt===sequence&&window&&!window.isDestroyed())window.webContents.stop();reject(Error('PUBLIC_PAGE_TIMEOUT'));},4000);})]);
   if(closing||attempt!==sequence)return;
   window.webContents.setAudioMuted(true);fit();receipt(target===OFFLINE?'empty':'display_loaded');
   if(config.smoke){
    const text=await window.webContents.executeJavaScript('document.body.textContent',true);
    const result={isolated_offscreen:true,empty_screen:text.includes('节目画面准备中'),audio_muted:window.webContents.isAudioMuted(),remote_requests:remoteRequests};
    process.stdout.write(JSON.stringify(result)+'\n');app.exit(result.empty_screen&&result.audio_muted&&remoteRequests===0?0:1);
   }
  }catch{if(config.smoke){process.stderr.write('Isolated offscreen smoke failed.\n');app.exit(1);}else await waitScreen('PUBLIC_PAGE_UNAVAILABLE',attempt);}
  finally{clearTimeout(timeout);}
 }
 function selectPage(url){target=url||OFFLINE;void loadTarget();}
 function createWindow(){
  if(config.smoke)app.dock?.hide();
  const displaySession=session.fromPartition('ai-streamer-public-display',{cache:false});
  displaySession.setPermissionCheckHandler(()=>false);displaySession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  displaySession.on('will-download',event=>event.preventDefault());
  displaySession.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url))remoteRequests++;callback({cancel:!policy.allowRequest(details)});});
  displaySession.webRequest.onHeadersReceived((details,callback)=>callback({cancel:!policy.allowResponse(details)}));
  window=new BrowserWindow({title:TITLE,width:1280,height:720,minWidth:640,minHeight:360,show:false,frame:false,resizable:true,backgroundColor:'#101923',autoHideMenuBar:true,movable:true,
   webPreferences:{session:displaySession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:false,backgroundThrottling:false,disableDialogs:true,navigateOnDragDrop:false,offscreen:config.smoke}});
  window.setAspectRatio(16/9);window.webContents.setAudioMuted(true);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!policy.allowNavigation(url))event.preventDefault();});
  window.webContents.on('will-frame-navigate',event=>{if(!event.isMainFrame||!policy.allowNavigation(event.url))event.preventDefault();});
  window.webContents.on('will-redirect',event=>event.preventDefault());window.webContents.on('will-attach-webview',event=>event.preventDefault());window.webContents.on('will-prevent-unload',event=>event.preventDefault());
  window.webContents.on('page-title-updated',event=>{event.preventDefault();window?.setTitle(TITLE);});
  window.webContents.on('did-finish-load',()=>{if(!window||window.isDestroyed())return;window.webContents.setAudioMuted(true);fit();void window.webContents.insertCSS('html,body{-webkit-app-region:drag!important}a,button,input,select,textarea{-webkit-app-region:no-drag!important}').catch(()=>{});});
  window.webContents.on('render-process-gone',()=>{if(config.smoke)app.exit(1);else if(!closing)void waitScreen('DISPLAY_RENDERER_STOPPED',++sequence);});
  window.on('resize',fit);window.on('closed',()=>{window=null;closing=true;clearRetry();receipt('closed');app.quit();});
  if(!config.smoke){
   Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'节目窗口',submenu:[{label:'显示节目',accelerator:'CmdOrCtrl+1',click:()=>selectPage(config.url)},{label:'显示等待页',accelerator:'CmdOrCtrl+2',click:()=>selectPage(config.standbyUrl)},{label:'重新载入',accelerator:'CmdOrCtrl+R',click:()=>void loadTarget()},{type:'separator'},{label:'退出',accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}]}]));
   window.showInactive();
  }
  void loadTarget();
 }
 if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{});app.on('before-quit',()=>{closing=true;++sequence;clearRetry();receipt('closing');});app.on('window-all-closed',()=>app.quit());
  app.whenReady().then(createWindow).catch(()=>{receipt('STARTUP_FAILED');app.exit(1);});
 }
}
