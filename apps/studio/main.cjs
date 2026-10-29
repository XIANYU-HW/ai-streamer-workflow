'use strict';
const {app,BrowserWindow,ipcMain,Menu,dialog,shell,powerMonitor,session,safeStorage}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {WorkspaceStore}=require('./data-store.cjs');
const {VoiceVault}=require('./voice-vault.cjs');
const {MiniMaxProvider}=require('./cloud-provider.cjs');
const {CloudVoice}=require('./cloud-voice.cjs');
const {SYSTEM_VOICES}=require('./system-voices.cjs');
const {VoiceEvidence}=require('./voice-evidence.cjs');
const {createLocalService}=require('./local-service.cjs');
const {LiveRuntime}=require('./live-runtime.cjs');
const {RuntimeBridge}=require('./runtime-bridge.cjs');
const {createRuntimeHttp}=require('./runtime-http.cjs');
const {writeRuntimeAccess}=require('./runtime-access.cjs');
const {createSpendingControl}=require('./spending-control.cjs');
const {APP_NAME,APP_ID,resolveDataDirectory,prepareDataDirectory}=require('./public-config.cjs');
const {trustedIPC,allowedNavigation}=require('./desktop-policy.cjs');
const model=require('./renderer/model.js');

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
const smokeMode=process.argv.includes('--public-smoke');
const testDirectory=process.env.AI_STREAMER_STUDIO_DATA_DIR;
if(smokeMode&&!testDirectory)throw Error('Isolated smoke requires an explicit temporary public data directory.');
const defaultData=prepareDataDirectory(resolveDataDirectory({appData:app.getPath('appData'),override:testDirectory}));
app.setPath('userData',defaultData);
if(smokeMode){app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');}
let mainWindow,service,store,voiceVault,cloudVoice,voiceEvidence,quitting=false,closeInProgress=false,voiceBindings={},settingsError=null;
let runtime,runtimeBridge,runtimeHttp,runtimeAccess;
const outputs=new Set(),pendingClose=new Map(),token=crypto.randomBytes(32).toString('hex');
const backgroundLaunch=process.argv.includes('--studio-background');
let initialWindowShown=false;
let mainRendererIdentity=null,mainRendererObservation=null,mainRendererTermination=null,pendingRendererRecovery=null,rendererRecoveryDialog=null;
let lifecycleLogTail=Promise.resolve();
const settingsFile=path.join(defaultData,'device-settings.json');
const settingsQueue={tail:Promise.resolve()};
function guarded(handler){return async(event,...args)=>{if(!service||!trustedIPC(event,mainWindow?.webContents,service.origin))throw new Error('此窗口不能访问角色资料。');return handler(...args);};}
async function invalidateRuntime(){
 // Explicit user lifecycle operations invalidate a session even if no renderer
 // readiness edge occurred (e.g. a controller opened while the editor was busy).
 const disarmed=runtimeBridge?.disarm();
 // A fresh invalidation retries the real stop barrier. An older rejected
 // readiness promise must not override a subsequently confirmed recovery.
 void disarmed?.catch(()=>{});await runtime?.invalidate('MANUAL_CONTROL');
}
async function configureVoiceCredential(operation){await invalidateRuntime();await service.cancelSpeech();try{return await operation();}catch{throw new Error('本机密钥操作未完成，请检查当前选择后重试。');}}
let pendingErrorMessage=null,errorDialogPending=null;
function errorDialogOptions(message){return {type:'error',title:'工作室未完成这项操作',message,buttons:['好'],defaultId:0,cancelId:0};}
function flushPendingError(){
 if(quitting||errorDialogPending||rendererRecoveryDialog||pendingRendererRecovery||pendingErrorMessage===null)return errorDialogPending||Promise.resolve();
 const parent=mainWindow;
 if(!parent||parent.isDestroyed()||!parent.isVisible()||parent.isMinimized()||!parent.isFocused())return Promise.resolve();
 const message=pendingErrorMessage;pendingErrorMessage=null;
 let finish;const pending=new Promise(resolve=>{finish=()=>{errorDialogPending=null;resolve();void flushRendererRecovery();};});
 errorDialogPending=pending;
 // On macOS only a shown parent gives a nonblocking sheet. Never show/focus it here.
 try{Promise.resolve(dialog.showMessageBox(parent,errorDialogOptions(message))).then(finish,finish);}catch{finish();}
 return pending;
}
function notifyError(error){
 if(quitting)return Promise.resolve();
 if(errorDialogPending)return errorDialogPending;
 if(pendingErrorMessage===null)pendingErrorMessage=error?.message||String(error);
 return flushPendingError();
}

function recordRendererIdentity(win){
 if(win!==mainWindow||win.isDestroyed()||win.webContents.isDestroyed()||win.webContents.isCrashed())return null;
 const processId=win.webContents.getOSProcessId();if(!Number.isSafeInteger(processId)||processId<=0)return null;
 const previous=mainRendererObservation;
 if(!previous||previous.identity.web_contents_id!==win.webContents.id||previous.identity.process_id!==processId||previous.terminated){
  // Record what native code actually observed even if the bridge refuses it.
  // Otherwise the later death of an unknown replacement could certify its predecessor.
  mainRendererObservation={identity:Object.freeze({web_contents_id:win.webContents.id,process_id:processId,incarnation_id:crypto.randomUUID()}),accepted:false,terminated:false};
 }
 const observed=mainRendererObservation;
 if(!observed.accepted){if(runtimeBridge?.observeRenderer(observed.identity)!==true)return null;observed.accepted=true;mainRendererIdentity=observed.identity;}
 return observed.identity;
}
function nativeRendererEnded(win){const observed=mainRendererObservation;return win===mainWindow&&observed?.accepted===true&&observed.terminated===true&&observed.identity===mainRendererIdentity&&mainRendererTermination?.identity===observed.identity&&observed.identity.web_contents_id===win.webContents.id;}
function logRendererLifecycle(event){
 const line=JSON.stringify({at_utc:new Date().toISOString(),...event})+'\n',file=path.join(defaultData,'renderer-lifecycle.jsonl');
 // Fixed metadata only; no dialogue, credentials, lease capabilities or arbitrary error text.
 lifecycleLogTail=lifecycleLogTail.catch(()=>{}).then(async()=>{let size=0;try{size=(await fs.stat(file)).size;}catch(e){if(e.code!=='ENOENT')throw e;}if(size+Buffer.byteLength(line)<=512*1024)await fs.appendFile(file,line,{mode:0o600});}).catch(()=>{});
}
async function flushRendererRecovery(){
 const pending=pendingRendererRecovery,win=pending?.win;
 if(!pending||quitting||closeInProgress||rendererRecoveryDialog||errorDialogPending||!win||win.isDestroyed()||!win.isVisible()||win.isMinimized()||!win.isFocused())return;
 pendingRendererRecovery=null;
 const task=Promise.resolve().then(async()=>{
  try{
   const choice=await dialog.showMessageBox(win,{type:'error',title:'工作室窗口已停止',message:pending.stopConfirmed?'声音来源已停止，原会话已撤销。':'窗口已退出，声音停止尚未完全确认。',detail:'已保存的角色、场景和记忆保留。重新打开仅恢复窗口；执行端仍需重新建立声音会话。',buttons:['重新打开','退出'],defaultId:0,cancelId:1});
   if(quitting||win.isDestroyed()||win!==mainWindow)return;
   if(choice.response===0)await win.loadURL(service.origin+'/index.html');else await requestQuit();
  }catch(e){notifyError(e);}
 }).finally(()=>{if(rendererRecoveryDialog===task){rendererRecoveryDialog=null;void flushPendingError();}});rendererRecoveryDialog=task;return task;
}
async function boundedRendererCleanup(operation){
 let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('声音停止尚未完全确认。')),runtimeBridge?.stopTimeoutMs||6000);});
 try{return await Promise.race([Promise.resolve().then(operation),timeout]);}finally{clearTimeout(timer);}
}
async function onRendererGone(win,privateWindow,details){
 if(!privateWindow){if(!win.isDestroyed())win.destroy();return;}
 if(win!==mainWindow)return;
 // The old identity was captured while that native process was alive. Never read
 // its now-zero getOSProcessId or manufacture an identity from the crash event.
 const observed=mainRendererObservation,identity=observed?.identity;
 const known=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']);
 const reason=known.has(details?.reason)?details.reason:'unknown',exitCode=Number.isSafeInteger(details?.exitCode)?details.exitCode:null;
 const nativeGone=win.webContents.isDestroyed()||win.webContents.isCrashed()||win.webContents.getOSProcessId()===0;
 if(!nativeGone){logRendererLifecycle({event:'ignored_gone_event_for_live_renderer',reason,exit_code:exitCode,...(identity||{})});return;}
 const proof=observed?.accepted===true&&!observed.terminated&&identity===mainRendererIdentity&&identity.web_contents_id===win.webContents.id&&exitCode!==null&&runtimeBridge?.rendererGone({identity,reason,exit_code:exitCode})===true;
 if(observed)observed.terminated=true;
 if(proof)mainRendererTermination={identity,reason,exit_code:exitCode};
 logRendererLifecycle({event:'render_process_gone',reason,exit_code:exitCode,...(identity||{}),native_identity_matched:proof});
 // Invalidation must not prevent editor/public cleanup when a stop fails.
 const results=await Promise.allSettled([boundedRendererCleanup(()=>invalidateRuntime()),boundedRendererCleanup(()=>service?.revokeEditor())]);
 const lastStop=runtimeBridge?.status().last_stop,stopConfirmed=proof&&results.every(x=>x.status==='fulfilled')&&lastStop?.confirmed===true&&lastStop.method==='renderer_process_terminated'&&lastStop.renderer_identity?.incarnation_id===identity.incarnation_id&&lastStop.renderer_identity.web_contents_id===identity.web_contents_id&&lastStop.renderer_identity.process_id===identity.process_id;
 logRendererLifecycle({event:'renderer_cleanup',reason,exit_code:exitCode,...(identity||{}),stop_confirmed:stopConfirmed,backend_cancelled:lastStop?.backend_cancelled===true});
 if(!quitting&&!closeInProgress){pendingRendererRecovery={win,stopConfirmed};void flushRendererRecovery();}
}
function showInitialWindow(){if(backgroundLaunch)mainWindow.showInactive();else mainWindow.show();initialWindowShown=true;}
function handleActivate(){if(backgroundLaunch&&!initialWindowShown)return;mainWindow?.show();mainWindow?.focus();void flushRendererRecovery();void flushPendingError();}
function handleSecondInstance(_event,commandLine=[]){
 if(commandLine.includes('--studio-background'))return;
 if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();void flushRendererRecovery();void flushPendingError();}
}

function summary(data){return `${data.characters.length} 位角色 · ${data.scenes.length} 个场景 · ${data.sessions.length} 场记录 · ${data.memories.length} 条记忆`;}
async function readSettings(){try{const v=JSON.parse(await fs.readFile(settingsFile,'utf8'));if(v.version!==1||typeof v.voices!=='object'||!v.voices||Array.isArray(v.voices))throw new Error('本机声音偏好格式不兼容');voiceBindings=v.voices;}catch(e){if(e.code!=='ENOENT')settingsError=e.message;}}
async function bindVoice(profile,id){
 await invalidateRuntime();
 if(settingsError)throw new Error('本机声音偏好无法读取，原文件已保留：'+settingsError);
 if(typeof profile!=='string'||!/^voice-[A-Za-z0-9_-]{1,74}$/.test(profile)||typeof id!=='string'||id.length>200)throw new Error('声音绑定无效');
 const current=await store.load();if(current.data?.active_session_id){const active=current.data.sessions.find(s=>s.session_id===current.data.active_session_id);const participant=active?.character_snapshots.find(c=>c.voice.profile_id===profile);if(participant&&id!==(voiceBindings[profile]??participant.voice.local_voice_id))throw new Error('本场已锁定此角色的本机音色，请结束本场后再修改。');}
 const task=settingsQueue.tail.then(async()=>{const next={...voiceBindings,[profile]:id};if(Object.keys(next).length>256)throw new Error('声音偏好数量过多');await fs.mkdir(defaultData,{recursive:true,mode:0o700});const temp=settingsFile+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify({version:1,voices:next}),{mode:0o600,flag:'wx'});await fs.rename(temp,settingsFile);voiceBindings=next;}finally{await fs.unlink(temp).catch(()=>{});}return {...voiceBindings};});settingsQueue.tail=task.catch(()=>{});return task;
}
async function importWorkspace(){
 const current=await store.load();if(current.data?.active_session_id)throw new Error('请先结束当前演练，再导入资料。');
 const choice=await dialog.showOpenDialog(mainWindow,{title:'迁移角色、场景与记忆',properties:['openFile'],filters:[{name:'工作室完整备份',extensions:['json']}]});
 if(choice.canceled)return {cancelled:true};
 const selected=choice.filePaths[0],stat=await fs.stat(selected);if(stat.size>96*1024*1024)throw new Error('含声音预览的完整备份不能超过 96 MiB。');
 const raw=await fs.readFile(selected,'utf8');let data,voiceTrial=null;try{const parsed=JSON.parse(raw.replace(/^\uFEFF/,''));const source=parsed.desktop_backup_version===1?parsed.workspace:parsed;data=model.validate(source);if(parsed.desktop_backup_version===1){await voiceVault.validatePortable(parsed.voice_trial);voiceTrial=parsed.voice_trial;}}catch(e){throw new Error('备份未通过检查，现有资料没有改变：'+e.message);}
 const answer=await dialog.showMessageBox(mainWindow,{type:'question',buttons:['导入这份资料','取消'],defaultId:0,cancelId:1,title:'确认迁移资料',message:summary(data),detail:current.data?'导入前会自动保存当前资料的独立备份。角色、舞台、记忆及声音候选一起导入。密钥与付费授权不会导入；当前本机费用设置保持。':'将导入你选择的备份。付费服务默认关闭，需在本机单独配置。'});
 if(answer.response!==0)return {cancelled:true};
 await invalidateRuntime();await service.cancelSpeech();const result=await store.importData(data,current.revision);
 try{if(voiceTrial)await voiceVault.importPortable(voiceTrial);}catch(e){
  if(current.data){const latest=await store.load();await store.save(current.data,latest.revision);await service.revokeEditor();setImmediate(()=>mainWindow.loadURL(service.origin+'/index.html').catch(notifyError));throw new Error('声线资料导入未完成，原角色资料已恢复。原备份保留：'+e.message);}
  await service.revokeEditor();setImmediate(()=>mainWindow.loadURL(service.origin+'/index.html').catch(notifyError));throw new Error('角色资料已导入，但声线资料未完成；原导入文件保留。'+e.message);
 }
 await service.revokeEditor();
 setImmediate(()=>mainWindow.loadURL(service.origin+'/index.html').catch(notifyError));
 return {cancelled:false,summary:summary(data),backup:!!result.backupPath};
}
async function exportWorkspace(){
 const data=await store.exportData();if(!data)throw new Error('尚无可导出的资料。');
 const choice=await dialog.showSaveDialog(mainWindow,{title:'保存完整资料备份',defaultPath:'角色工作室-完整资料-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'JSON',extensions:['json']}]});
 if(choice.canceled)return {cancelled:true};
 const bundle={desktop_backup_version:1,workspace:data,voice_trial:await voiceVault.exportPortable()};
 const target=choice.filePath,temp=target+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(bundle,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,target);}finally{await fs.unlink(temp).catch(()=>{});}
 return {cancelled:false,path:target};
}
async function recover(){
 const points=await store.listRecoveryPoints();if(!points.length)throw new Error('没有可用的自动备份。原资料保留，请使用自己保存的完整备份恢复。');
 let current=null;try{current=await store.load();}catch{}if(current?.data?.active_session_id)throw new Error('请先结束当前演练，再还原资料。');const p=current?.data?(points.find(x=>x.id!=='previous')||points[0]):points[0],choice=await dialog.showMessageBox(mainWindow,{type:'question',buttons:['恢复此备份','取消'],defaultId:1,cancelId:1,title:'从自动备份恢复',message:`${p.characters} 位角色 · ${p.scenes} 个场景 · ${p.memories} 条记忆`,detail:`备份时间：${p.updated_at}\n还原前会保存当前资料；损坏原件会另存。请核对备份时间与资料数量。`});
 if(choice.response!==0)return {cancelled:true};
 await invalidateRuntime();await service.cancelSpeech();if(current?.data)await store.restoreFromBackup(p.id,current.revision);else await store.recoverFromBackup(p.id);await service.revokeEditor();await mainWindow.loadURL(service.origin+'/index.html');return {cancelled:false};
}
function prepareClose(force=false){
 if(!mainWindow||mainWindow.isDestroyed())return Promise.resolve({ready:true});
 if(nativeRendererEnded(mainWindow))return Promise.resolve({ready:true,reason:'renderer_process_terminated'});
 const url=mainWindow.webContents.getURL();
 if(!url||url==='about:blank'||new URL(url).pathname==='/welcome.html')return Promise.resolve({ready:true});
 return new Promise(resolve=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pendingClose.delete(id);resolve({ready:false,reason:'未收到保存与停声确认'});},7000);pendingClose.set(id,result=>{clearTimeout(timer);pendingClose.delete(id);resolve(result);});mainWindow.webContents.send('desktop:prepare-close',{id,force});});
}
async function requestQuit(){
 if(quitting||closeInProgress)return;closeInProgress=true;
 try{
  let result=await prepareClose();
  if(!result.ready){const choice=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['返回工作室','放弃未保存修改并退出'],defaultId:0,cancelId:0,title:'退出前确认',message:result.reason==='unsaved'?'角色还有未保存的修改。':result.reason,detail:'已保存的角色、场景和记忆会保留。'});if(choice.response!==1)return;result=await prepareClose(true);}
  if(!result.ready&&result.reason.includes('仍在保存')){notifyError(new Error(result.reason));return;}await store.load().catch(()=>{});await settingsQueue.tail;await runtime?.close();await runtimeHttp?.close();await runtimeBridge?.close();await runtimeAccess?.close();await service?.cancelSpeech();await service?.close();quitting=true;
  for(const output of outputs)if(!output.isDestroyed())output.destroy();
  if(mainWindow&&!mainWindow.isDestroyed())mainWindow.destroy();await lifecycleLogTail;app.quit();
 }catch(e){notifyError(e);}finally{closeInProgress=false;}
}
function configureWindow(win,privateWindow=false){
 win.webContents.setWindowOpenHandler(({url})=>{if(service&&allowedNavigation(url,service.origin,['/overlay.html','/scene-output.html']))openOutput(url);return {action:'deny'};});
 win.webContents.on('will-navigate',(event,url)=>{if(!service||!allowedNavigation(url,service.origin,privateWindow?['/','/index.html','/welcome.html']:['/overlay.html','/scene-output.html']))event.preventDefault();});
 win.webContents.on('will-redirect',event=>event.preventDefault());
 win.webContents.on('render-process-gone',(_event,details)=>{void onRendererGone(win,privateWindow,details);});
 if(privateWindow){win.webContents.on('did-finish-load',()=>recordRendererIdentity(win));win.on('focus',()=>{void flushRendererRecovery();void flushPendingError();});}
}
function openOutput(url){
 const win=new BrowserWindow({title:'角色工作室 · 公开画面',width:1100,height:760,backgroundColor:'#10111c',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});outputs.add(win);win.on('closed',()=>outputs.delete(win));configureWindow(win);win.loadURL(url).catch(notifyError);
}
function setMenu(){
 const send=command=>mainWindow?.webContents.send('desktop:command',command);
 Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'角色工作室',submenu:[{label:'关于角色工作室',click:()=>dialog.showMessageBox(mainWindow,{type:'info',message:`角色工作室 ${app.getVersion()} 桌面版`,detail:'本地角色、舞台与记忆工作室。最小化继续运行；暂停停止声音；退出保存并收尾。支持角色声音设计与 MiniMax 流式语音；实际声音质量与直播延迟以本机试听结果为准。'})},{type:'separator'},{label:'退出角色工作室',accelerator:'CmdOrCtrl+Q',click:requestQuit}]},
  {label:'资料',submenu:[{label:'导入完整资料…',click:()=>send('import')},{label:'导出完整备份…',accelerator:'CmdOrCtrl+Shift+S',click:()=>send('export')},{label:'打开资料与自动备份文件夹',click:()=>shell.openPath(defaultData)},{label:'从自动备份恢复…',click:()=>send('recover')}]},
  {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{label:'显示工作室',click:()=>{mainWindow.show();mainWindow.focus();void flushRendererRecovery();void flushPendingError();}},{label:'停止声音与动作',accelerator:'CmdOrCtrl+.',click:()=>send('stop')}]}
 ]));
}
async function start(){
 await app.whenReady();if(smokeMode)app.dock?.hide();await fs.mkdir(defaultData,{recursive:true,mode:0o700});await readSettings();store=new WorkspaceStore({directory:defaultData,model});
 voiceVault=new VoiceVault({directory:defaultData,
  protect:async key=>{if(!await safeStorage.isAsyncEncryptionAvailable())throw new Error('系统加密暂不可用，密钥没有保存。');return (await safeStorage.encryptStringAsync(key)).toString('base64');},
  unprotect:async encrypted=>(await safeStorage.decryptStringAsync(Buffer.from(encrypted,'base64'))).result});
 voiceEvidence=new VoiceEvidence({directory:defaultData});
 let spendingControl;
 cloudVoice=new CloudVoice({vault:voiceVault,provider:new MiniMaxProvider({getKey:()=>voiceVault.getKey()}),getWorkspace:()=>store.load(),assertCanStart:()=>spendingControl?.assertNotUpdating()});
 service=await createLocalService({root:path.join(__dirname,'renderer'),port:0,token,cloud:cloudVoice});
 runtimeBridge=new RuntimeBridge({send:value=>{if(!mainWindow||mainWindow.isDestroyed()||mainWindow.webContents.isDestroyed()||mainWindow.webContents.isCrashed())return false;mainWindow.webContents.send('runtime:command',value);return true;},cancelSpeech:()=>service.cancelSpeech(),isEditorLease:owner=>service.hasEditorLease(owner)});
 runtime=new LiveRuntime({getWorkspace:async()=>{const result=await store.load();if(!result.data)throw new Error('Workspace unavailable');return result.data;},play:job=>runtimeBridge.play(job),stop:(reason,target)=>runtimeBridge.stop(reason,target)});runtimeBridge.attach(runtime);
 const runtimeApi=Object.fromEntries(['acquireLease','renewLease','openSession','enqueue','append','cancel','personas'].map(name=>[name,(...args)=>runtime[name](...args)]));runtimeApi.status=()=>{const renderer=runtimeBridge.status();return {...runtime.status(),renderer};};
 spendingControl=createSpendingControl({vault:voiceVault,runtime,cloud:cloudVoice});
 runtimeApi.acquireLease=request=>{spendingControl.assertNotUpdating();return runtime.acquireLease(request);};
 runtimeApi.spendingStatus=spendingControl.status;runtimeApi.configureSpending=async()=>{throw Object.assign(new Error('Use local settings to authorize spending.'),{code:'FORBIDDEN'});};
 const runtimeTokens=Object.fromEntries(['control','producer','monitor'].map(scope=>[scope,crypto.randomBytes(32).toString('hex')]));
 runtimeHttp=await createRuntimeHttp({runtime:runtimeApi,port:0,tokens:runtimeTokens});runtimeAccess=await writeRuntimeAccess({directory:defaultData,origin:runtimeHttp.origin,tokens:runtimeTokens});
 const editorSession=session.fromPartition('persist:ai-streamer-studio-public');
 editorSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));editorSession.setPermissionCheckHandler(()=>false);
 editorSession.webRequest.onBeforeSendHeaders({urls:[service.origin+'/*']},(details,callback)=>{const headers={...details.requestHeaders};headers['X-Studio-Desktop']=token;callback({requestHeaders:headers});});
 editorSession.on('will-download',(event,item)=>{const url=item.getURL();if(!url.startsWith('blob:'+service.origin+'/')){event.preventDefault();return;}item.setSaveDialogOptions({title:'保存音频或备份'});});
 mainWindow=new BrowserWindow({title:testDirectory?'角色工作室 · 隔离验证':'角色工作室',width:1440,height:960,minWidth:1080,minHeight:680,show:false,backgroundColor:'#11121d',webPreferences:{preload:path.join(__dirname,'preload.cjs'),session:editorSession,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:smokeMode}});
 configureWindow(mainWindow,true);if(testDirectory)mainWindow.on('page-title-updated',event=>event.preventDefault());if(!smokeMode)mainWindow.once('ready-to-show',showInitialWindow);mainWindow.on('close',event=>{if(!quitting){event.preventDefault();void requestQuit();}});
 ipcMain.handle('workspace:load',guarded(()=>store.load()));
 ipcMain.handle('workspace:save',guarded(async(data,revision)=>{await invalidateRuntime();return store.save(data,revision);}));
 ipcMain.handle('runtime:ready',guarded(value=>recordRendererIdentity(mainWindow)?runtimeBridge.ready(value):{ok:false,armed:false}));
 ipcMain.handle('runtime:receipt',guarded(value=>runtimeBridge.receipt(value)));
 ipcMain.handle('runtime:stopped',guarded(value=>runtimeBridge.stopped(value)));
 ipcMain.handle('runtime:cancel',guarded(async value=>{if(!value||typeof value.reason!=='string'||value.reason.length>120||Object.keys(value).length!==1)throw new Error('运行取消请求无效。');await invalidateRuntime();return {cancelled:true};}));
 ipcMain.handle('runtime:status',guarded(()=>runtimeApi.status()));
 ipcMain.handle('workspace:import',guarded(importWorkspace));ipcMain.handle('workspace:export',guarded(exportWorkspace));ipcMain.handle('workspace:recover',guarded(recover));
 ipcMain.handle('workspace:fresh',guarded(async()=>{const existing=await store.load();if(existing.data)throw new Error('已有资料，未创建新库。');await store.save(model.defaults(),0);setImmediate(()=>mainWindow.loadURL(service.origin+'/index.html'));return true;}));
 ipcMain.handle('desktop:info',guarded(()=>({version:app.getVersion(),platform:process.platform,dataDirectory:defaultData,settingsError})));
 ipcMain.handle('desktop:voice-bindings',guarded(()=>({...voiceBindings})));
 ipcMain.handle('desktop:bind-voice',guarded(bindVoice));
 ipcMain.handle('voice:receipt',guarded(value=>voiceEvidence.append(value)));
 ipcMain.handle('voice:measurements',guarded(()=>voiceEvidence.summary()));
 ipcMain.handle('voice:status',guarded(()=>voiceVault.status()));
 ipcMain.handle('voice:spending-policy',guarded(()=>spendingControl.status()));
 ipcMain.handle('voice:set-spending-policy',guarded(value=>spendingControl.configure(value)));
 ipcMain.handle('voice:save-key',guarded(key=>configureVoiceCredential(()=>voiceVault.setKey(key))));
 ipcMain.handle('voice:use-session-key',guarded(key=>configureVoiceCredential(()=>voiceVault.setSessionKey(key))));
 ipcMain.handle('voice:clear-session-key',guarded(()=>configureVoiceCredential(()=>voiceVault.clearSessionKey())));
 ipcMain.handle('voice:candidates',guarded(()=>voiceVault.candidates()));
 ipcMain.handle('voice:system-options',guarded(()=>SYSTEM_VOICES.map(v=>({...v}))));
 ipcMain.handle('voice:preview',guarded(id=>voiceVault.preview(id)));
 ipcMain.handle('voice:design',guarded(async request=>{await invalidateRuntime();await service.cancelSpeech();return cloudVoice.design(request);}));
 ipcMain.handle('voice:cancel',guarded(async()=>{await invalidateRuntime();return service.cancelSpeech();}));
 ipcMain.handle('desktop:show-data',guarded(()=>shell.openPath(defaultData)));
 ipcMain.on('desktop:close-result',(event,result)=>{if(trustedIPC(event,mainWindow?.webContents,service.origin)&&result&&typeof result.id==='string')pendingClose.get(result.id)?.({ready:result.ready===true,reason:String(result.reason||'')});});
 if(!smokeMode)setMenu();powerMonitor.on('suspend',()=>{mainWindow?.webContents.send('desktop:suspend');void invalidateRuntime().catch(()=>{});void service.cancelSpeech().catch(()=>{});void service.invalidatePublic().catch(()=>{});});
 powerMonitor.on('resume',()=>mainWindow?.webContents.send('desktop:resume'));
 let recoveryRequired=false;
 try{const loaded=await store.load();if(!loaded.data)await store.save(model.defaults(),0);}
 catch(error){recoveryRequired=true;if(smokeMode)throw error;}
 await mainWindow.loadURL(service.origin+(recoveryRequired?'/welcome.html':'/index.html'));
 console.log('AI_STREAMER_STUDIO_PUBLIC_READY '+JSON.stringify({version:app.getVersion(),origin:service.origin,dataDirectory:defaultData,pid:process.pid}));
 if(smokeMode){
  let snapshot;
  for(let attempt=0;attempt<80;attempt++){
   snapshot=await mainWindow.webContents.executeJavaScript(`typeof db!=='undefined'&&db?{characters:db.characters.length,scenes:db.scenes.length,sessions:db.sessions.length,memories:db.memories.length,assets:Object.keys(db.assets).length,save:document.getElementById('saveStatus').textContent}:null`);
   if(snapshot?.save?.startsWith('已保存'))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!snapshot||['characters','scenes','sessions','memories','assets'].some(k=>snapshot[k]!==0))throw Error('New public workspace was not empty.');
  if(mainWindow.isVisible())throw Error('Smoke window must remain hidden.');
  const errors=[];mainWindow.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(String(message).slice(0,200));});
  const edited=await mainWindow.webContents.executeJavaScript(`(async()=>{
   await change(d=>M.addCharacter(d,M.createCharacter('测试角色')),'');guardedNav('characters');fillProfile();
   const character=db.selected_character_id;await change(d=>M.addScene(d,M.createScene('测试舞台')),'');await change(d=>M.setCast(d,d.selected_scene_id,[character]),'');
   const saved=M.validate(db);return {characters:saved.characters.length,scenes:saved.scenes.length,driver:saved.characters[0].driver,provider:saved.characters[0].voice.provider,rendered:document.querySelectorAll('#actors .stage-actor').length};
  })()`);
  if(edited.characters!==1||edited.scenes!==1||edited.driver!==''||edited.provider!==''||edited.rendered!==1)throw Error('Blank-to-user-created editing smoke failed.');
  const spending=await voiceVault.status(),state=runtimeApi.status();
  if(spending.budget_usd!==0||spending.spending_locked!==true||state.session!==null||state.active!==null||state.queue_depth!==0)throw Error('Default spending or runtime was not inactive.');
  if(errors.length)throw Error('Renderer reported errors during editing.');
  console.log('PUBLIC_STUDIO_SMOKE '+JSON.stringify({empty_workspace:true,create_character_and_scene:true,rendered_user_character:true,model_provider_unselected:true,spending_locked:true,runtime_session:null,window_visible:false,renderer_errors:0}));
  quitting=true;await runtime.close();await runtimeBridge.close();await runtimeHttp.close();await runtimeAccess.close();await service.close();mainWindow.destroy();app.quit();
 }

}
if(!app.requestSingleInstanceLock()){app.quit();}
else{
 app.on('second-instance',handleSecondInstance);
 app.on('activate',handleActivate);
 app.on('before-quit',event=>{if(!quitting){event.preventDefault();void requestQuit();}});
 app.on('window-all-closed',()=>{if(!quitting)void requestQuit();});
 start().catch(async e=>{await runtimeHttp?.close().catch(()=>{});await runtime?.close().catch(()=>{});await runtimeBridge?.close().catch(()=>{});await runtimeAccess?.close().catch(()=>{});await service?.close().catch(()=>{});if(!smokeMode){try{await dialog.showMessageBox(errorDialogOptions(e?.message||String(e)));}catch{}}else console.error('PUBLIC_SMOKE_FAILED '+String(e?.message||e));quitting=true;app.quit();});
}
