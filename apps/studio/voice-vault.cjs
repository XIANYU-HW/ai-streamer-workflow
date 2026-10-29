'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const copy=v=>JSON.parse(JSON.stringify(v));
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(s);
const validDevice=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const money=n=>Math.round(n*1e6)/1e6,FORMATS=['mp3','wav','flac','ogg'],MAX_AUDIO=12*1024*1024,MAX_PORTABLE_AUDIO=64*1024*1024;
const costError=(code,message)=>Object.assign(new Error(message),{code});
const defaultPolicy=()=>({version:2,enabled:false,budget_usd:0});
function validateSpending(v){
 shape(v,['version','enabled','budget_usd']);
 if(v.version!==2||typeof v.enabled!=='boolean'||!amount(v.budget_usd)||(v.enabled&&v.budget_usd<=0))throw costError('INVALID_REQUEST','请输入有限的累计费用上限；关闭付费时可设为零。');
 return v;
}
const schemaError=()=>Error('声音资料格式无效，未导入或重置预算。');
function shape(v,required,optional=[]){if(!v||typeof v!=='object'||Array.isArray(v)||!required.every(k=>Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))throw schemaError();}
function text(v,max,empty=false){return typeof v==='string'&&v.length<=max&&(empty||v.trim().length>0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);}
function date(v){return typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
function amount(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1000000&&Math.abs(v-money(v))<1e-9;}
function validVoice(v){return text(v,200)&&!/[\r\n\t]/.test(v);}
function normalizeKey(key){if(typeof key!=='string'||!key.trim()||key.length>8192||/[\r\n\x00]/.test(key))throw Error('密钥格式无效。');return key.trim();}
function validateJob(j){
 shape(j,['id','kind','voice_id','status','cost_usd','reserved_usd','created_at'],['updated_at','usage_characters']);
 if(!validId(j.id)||!['design','speech'].includes(j.kind)||(j.voice_id!==null&&!validVoice(j.voice_id))||!['reserved','unknown','settled'].includes(j.status)||!amount(j.cost_usd)||!amount(j.reserved_usd)||j.reserved_usd<=0||!date(j.created_at)||(j.updated_at!==undefined&&!date(j.updated_at))||(j.usage_characters!==undefined&&(!Number.isSafeInteger(j.usage_characters)||j.usage_characters<0)))throw schemaError();
}
const CANDIDATE_REQUIRED=['candidate_id','character_id','voice_id','format','created_at'];
const CANDIDATE_OPTIONAL=['profile_id','variant','label','prompt','description','preview_text','design_job_id','estimated_allowance_usd','human_rating','expires_at','activation_status','activated_at'];
function validateCandidate(c,portable=false){
 shape(c,[...CANDIDATE_REQUIRED,portable?'audio':'file'],CANDIDATE_OPTIONAL);
 if(!validId(c.candidate_id)||!validId(c.character_id)||!validVoice(c.voice_id)||!FORMATS.includes(c.format)||!date(c.created_at)||(!portable&&c.file!==c.candidate_id+'.'+c.format))throw schemaError();
 for(const key of ['profile_id','design_job_id'])if(c[key]!==undefined&&!validId(c[key]))throw schemaError();
 for(const [key,max] of [['variant',100],['label',200],['prompt',4000],['description',4000],['preview_text',1000]])if(c[key]!==undefined&&!text(c[key],max,true))throw schemaError();
 if(c.estimated_allowance_usd!==undefined&&!amount(c.estimated_allowance_usd)||c.human_rating!==undefined&&c.human_rating!==null&&(!Number.isFinite(c.human_rating)||c.human_rating<0||c.human_rating>10))throw schemaError();
 if(c.expires_at!==undefined&&c.expires_at!==null&&!date(c.expires_at)||c.activated_at!==undefined&&c.activated_at!==null&&!date(c.activated_at)||c.activation_status!==undefined&&!['temporary','activated'].includes(c.activation_status))throw schemaError();
 if(c.activation_status==='activated'&&(!date(c.activated_at)||c.expires_at!==null)||c.activation_status==='temporary'&&(!date(c.expires_at)||c.activated_at!=null))throw schemaError();
}
function validateLedger(v,{portable=false}={}){
 shape(v,['version','owner_device_id','jobs','candidates']);
 if(v.version!==2||!validDevice(v.owner_device_id)||!Array.isArray(v.jobs)||!Array.isArray(v.candidates)||v.candidates.length>128)throw schemaError();
 const jobs=new Map();for(const j of v.jobs){validateJob(j);if(jobs.has(j.id))throw schemaError();jobs.set(j.id,j);}
 const ids=new Set();for(const c of v.candidates){validateCandidate(c,portable);if(ids.has(c.candidate_id)||c.design_job_id!==undefined&&jobs.get(c.design_job_id)?.kind!=='design')throw schemaError();ids.add(c.candidate_id);}
 return v;
}
function validateAudio(audio,format){
 if(!Buffer.isBuffer(audio)||audio.length<1||audio.length>MAX_AUDIO)throw schemaError();
 const sig=audio.subarray(0,4).toString('ascii');
 const valid=format==='mp3'?(audio.length>=3&&(sig.startsWith('ID3')||audio[0]===255&&(audio[1]&224)===224)):format==='wav'?(audio.length>=12&&sig==='RIFF'&&audio.subarray(8,12).toString('ascii')==='WAVE'):format==='flac'?sig==='fLaC':format==='ogg'?sig==='OggS':false;
 if(!valid)throw schemaError();return audio;
}
function parsePortable(bundle){
 validateLedger(bundle,{portable:true});let total=0;const audio=new Map();
 for(const c of bundle.candidates){if(typeof c.audio!=='string'||!c.audio.length||c.audio.length>MAX_AUDIO*4/3||c.audio.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(c.audio))throw schemaError();total+=c.audio.length;if(total>MAX_PORTABLE_AUDIO)throw schemaError();const bytes=validateAudio(Buffer.from(c.audio,'base64'),c.format);if(bytes.toString('base64')!==c.audio)throw schemaError();audio.set(c.candidate_id,bytes);}
 return audio;
}
function mergeJob(current,incoming){
 if(['kind','voice_id','created_at'].some(k=>current[k]!==incoming[k]))throw schemaError();
 const result={...copy(incoming),...copy(current),cost_usd:Math.max(current.cost_usd,incoming.cost_usd),reserved_usd:Math.max(current.reserved_usd,incoming.reserved_usd)};
 result.status=current.status===incoming.status?current.status:'unknown';
 if(current.updated_at||incoming.updated_at)result.updated_at=[current.updated_at,incoming.updated_at].filter(Boolean).sort().at(-1);
 if(current.usage_characters!==undefined||incoming.usage_characters!==undefined)result.usage_characters=Math.max(current.usage_characters??0,incoming.usage_characters??0);
 return result;
}
function mergeCandidate(current,incoming){
 if(['character_id','profile_id','voice_id','format','created_at'].some(k=>current[k]!==incoming[k]))throw schemaError();
 const result={...copy(incoming),...copy(current)};
 if(current.activation_status==='activated'||incoming.activation_status==='activated'){result.activation_status='activated';result.expires_at=null;result.activated_at=[current.activated_at,incoming.activated_at].filter(Boolean).sort()[0];}
 return result;
}
class VoiceVault{
 #sessionMode=false;
 #sessionKey=null;
 #credentialEpoch=0;
 #sessionCredential(){if(!this.#sessionKey)throw Error('本次会话密钥已清除，请本人重新填写；没有读取已保存密钥。');return this.#sessionKey;}
 constructor({directory,protect,unprotect}){if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('语音资料需要独立的绝对目录。');this.directory=directory;this.protect=protect;this.unprotect=unprotect;this.file=path.join(directory,'voice-library.json');this.keyFile=path.join(directory,'voice-credential.json');this.deviceFile=path.join(directory,'voice-device.json');this.spendingFile=path.join(directory,'voice-spending-policy.json');this.tail=Promise.resolve();}
 _queue(fn){const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 async _spending(){try{return validateSpending(await this._json(this.spendingFile,4096));}catch(e){if(e.code==='ENOENT')return defaultPolicy();throw costError('BUDGET_STATE_UNKNOWN','费用模式无法读取；没有重置累计记录或发送新请求。');}}
 configureSpending(input){return this._queue(async()=>{let value;try{shape(input,['enabled','budget_usd']);value=validateSpending({version:2,...copy(input)});}catch{throw costError('INVALID_REQUEST','费用设置无效；必须明确启用并设置有限的累计上限。');}await this._read();await this._atomic(this.spendingFile,value);return copy(value);});}
 _summary(v,p){const used=money(v.jobs.reduce((s,j)=>s+j.cost_usd,0)),unconfirmed=v.jobs.filter(j=>j.status!=='settled').length,locked=!p.enabled||p.budget_usd<=used||unconfirmed>0;return {enabled:p.enabled,budget_mode:'capped',budget_scope:[],budget_authorization_id:null,usage_mode:'local_user',budget_usd:p.budget_usd,remaining_usd:Math.max(0,money(p.budget_usd-used)),committed_usd:used,spending_locked:locked,design_budget_usd:p.budget_usd,design_remaining_usd:Math.max(0,money(p.budget_usd-used)),design_spending_locked:locked,unconfirmed_requests:unconfirmed,candidates:v.candidates.length,ledger_kind:'conservative_estimate_not_provider_invoice'};}
 spendingStatus(){return this._queue(async()=>this._summary(await this._read(),await this._spending(),await this._device()));}
 async _atomic(file,value,beforeCommit){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID()+'.tmp';let f;try{f=await fs.open(temp,'wx',0o600);await f.writeFile(JSON.stringify(value));await f.sync();await f.close();f=null;beforeCommit?.();await fs.rename(temp,file);}finally{await f?.close();await fs.unlink(temp).catch(()=>{});}}
 async _json(file,max=16*1024*1024){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw schemaError();return JSON.parse(await fs.readFile(file,'utf8'));}
 async _device(){
  try{const v=await this._json(this.deviceFile,1024);shape(v,['version','device_id']);if(v.version!==1||!validDevice(v.device_id))throw schemaError();return v.device_id;}
  catch(e){if(e.code!=='ENOENT')throw Error('本机声音设备记录无法读取；未重置试听预算。');}
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});let file;
  try{file=await fs.open(this.deviceFile,'wx',0o600);const id=crypto.randomUUID();await file.writeFile(JSON.stringify({version:1,device_id:id}));await file.sync();return id;}
  catch(e){if(e.code==='EEXIST')return this._device();throw Error('本机声音设备记录无法保存；未创建试听预算。');}finally{await file?.close();}
 }
 async _read(){
  const device=await this._device();let v;
  try{v=await this._json(this.file,Infinity);validateLedger(v);}
  catch(e){
   if(e.code!=='ENOENT')throw costError('BUDGET_STATE_UNKNOWN','声音费用记录无法读取，已保留原文件；请先处理记录，未重置预算。');
   try{await fs.lstat(this.spendingFile);throw costError('BUDGET_STATE_UNKNOWN','费用设置已存在但账本缺失；未创建新账本或恢复可用额度。');}catch(policyError){if(policyError.code!=='ENOENT')throw policyError;}
   let previews=[];try{previews=await fs.readdir(path.join(this.directory,'voice-previews'));}catch(error){if(error.code!=='ENOENT')throw Error('声音试听资料无法读取，未创建新预算。');}
   if(previews.length)throw Error('已有声音试听资料但缺少费用记录；未创建或重置试听预算。');
   v={version:2,owner_device_id:device,jobs:[],candidates:[]};await this._atomic(this.file,v);return v;
  }
  return v;
 }
 async setKey(key){
  const value=normalizeKey(key),epoch=++this.#credentialEpoch;
  const assertCurrent=()=>{if(epoch!==this.#credentialEpoch)throw Error('密钥使用方式已更改，之前的保存操作已取消。');};
  const encrypted=await this.protect(value);assertCurrent();if(typeof encrypted!=='string'||!encrypted)throw Error('本机加密不可用，未保存密钥。');
  await this._queue(async()=>{assertCurrent();await this._atomic(this.keyFile,{version:1,encrypted},assertCurrent);assertCurrent();this.#sessionKey=null;this.#sessionMode=false;});
  return {has_key:true,credential_mode:'saved'};
 }
 setSessionKey(key){const value=normalizeKey(key);this.#credentialEpoch++;this.#sessionKey=value;this.#sessionMode=true;return {has_key:true,credential_mode:'session'};}
 clearSessionKey(){this.#credentialEpoch++;this.#sessionKey=null;this.#sessionMode=true;return {has_key:false,credential_mode:'session'};}
 async getKey(){
  if(this.#sessionMode)return this.#sessionCredential();
  try{
   const v=await this._json(this.keyFile,16384);if(this.#sessionMode)return this.#sessionCredential();
   if(v.version!==1||typeof v.encrypted!=='string')throw Error('schema');
   const key=await this.unprotect(v.encrypted);if(this.#sessionMode)return this.#sessionCredential();
   if(typeof key!=='string'||!key)throw Error('empty');return key;
  }catch(e){if(this.#sessionMode)return this.#sessionCredential();if(e.code==='ENOENT')throw Error('请先在声音服务设置中填写 MiniMax API Key。');throw Error('本机语音密钥无法解密，请重新配置；没有发送语音请求。');}
 }
 status(){return this._queue(async()=>{
  const v=await this._read();let savedKey=false;
  if(!this.#sessionMode)try{const k=await this._json(this.keyFile,16384);savedKey=k.version===1&&typeof k.encrypted==='string';}catch(e){if(!this.#sessionMode&&e.code!=='ENOENT')throw Error('本机语音配置无法读取，请重新配置。');}
  return {has_key:this.#sessionMode?!!this.#sessionKey:savedKey,credential_mode:this.#sessionMode?'session':'saved',...this._summary(v,await this._spending(),await this._device())};
 });}
 reserve({kind,estimate_usd,voice_id=null}){return this._queue(async()=>{
  const v=await this._read(),p=await this._spending();
  if(!p.enabled||p.budget_usd<=0)throw costError('SPENDING_LOCKED','请先在本机明确启用付费并设置有限的累计费用上限。');
  if(v.jobs.some(j=>j.status!=='settled'))throw costError('BUDGET_STATE_UNKNOWN','有请求费用尚待核对，已保留预留金额；未再次发送请求。');
  if(!['design','speech'].includes(kind)||!Number.isFinite(estimate_usd)||!amount(money(estimate_usd))||money(estimate_usd)<=0||(voice_id!==null&&!validVoice(voice_id)))throw costError('INVALID_REQUEST','费用预估无效。');
  const spent=v.jobs.reduce((s,j)=>s+j.cost_usd,0);if(spent+estimate_usd>p.budget_usd+1e-9)throw costError('BUDGET_EXCEEDED','本次请求会超过已设置的累计费用上限，未向服务发送请求。');
  const id='job-'+crypto.randomUUID();v.jobs.push({id,kind,voice_id,status:'reserved',cost_usd:money(estimate_usd),reserved_usd:money(estimate_usd),created_at:new Date().toISOString()});
  try{await this._atomic(this.file,v);}catch{throw costError('BUDGET_STATE_UNKNOWN','费用预留无法保存，未向服务发送请求。');}return id;
 });}
 settle(id,{estimated_cost_usd,usage_characters,unknown=false}={}){return this._queue(async()=>{const v=await this._read(),j=v.jobs.find(x=>x.id===id);if(!j)throw Error('声音费用记录不存在。');if(j.status==='settled')return;if(unknown){j.status='unknown';}else{if(!Number.isFinite(estimated_cost_usd)||estimated_cost_usd<0||estimated_cost_usd>1000000||usage_characters!==undefined&&(!Number.isSafeInteger(usage_characters)||usage_characters<0))throw Error('声音用量回执无效。');j.cost_usd=money(estimated_cost_usd);j.status='settled';if(usage_characters!==undefined)j.usage_characters=usage_characters;}j.updated_at=new Date().toISOString();await this._atomic(this.file,v);});}
 addCandidate(candidate,audio){return this._queue(async()=>{
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||Object.hasOwn(candidate,'file')||Object.hasOwn(candidate,'audio'))throw Error('候选声音资料无效。');
  const c={...copy(candidate),created_at:candidate.created_at??new Date().toISOString(),file:candidate.candidate_id+'.'+candidate.format};validateCandidate(c);validateAudio(audio,c.format);
  const v=await this._read();if(v.candidates.some(x=>x.candidate_id===c.candidate_id))throw Error('候选已保存，未覆盖。');if(v.candidates.length>=128)throw Error('声音候选库已达到128条上限，请整理后继续。');v.candidates.push(c);validateLedger(v);
  await fs.mkdir(path.join(this.directory,'voice-previews'),{recursive:true,mode:0o700});const file=path.join(this.directory,'voice-previews',c.file);await fs.writeFile(file,audio,{flag:'wx',mode:0o600});try{await this._atomic(this.file,v);}catch(error){await fs.unlink(file).catch(()=>{});throw error;}return copy(c);
 });}
 candidates(){return this._queue(async()=>copy((await this._read()).candidates.map(({file,...rest})=>rest)));}
 async _preview(c){const file=path.join(this.directory,'voice-previews',c.file),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_AUDIO)throw Error('声音候选文件无效。');return validateAudio(await fs.readFile(file),c.format);}
 preview(id){return this._queue(async()=>{if(!validId(id))throw Error('候选编号无效。');const v=await this._read(),c=v.candidates.find(x=>x.candidate_id===id);if(!c)throw Error('声音候选不存在。');return {format:c.format,audio:(await this._preview(c)).toString('base64')};});}
 markActivated(id,timestamp=new Date().toISOString()){return this._queue(async()=>{if(!validId(id)||!date(timestamp))throw Error('声音激活信息无效。');const v=await this._read(),c=v.candidates.find(x=>x.candidate_id===id);if(!c)throw Error('声音候选不存在。');if(c.activation_status!=='activated'){c.activation_status='activated';c.activated_at=timestamp;c.expires_at=null;await this._atomic(this.file,v);}const {file,...result}=c;return copy(result);});}
 validatePortable(bundle){parsePortable(bundle);return true;}
 exportPortable(){return this._queue(async()=>{const v=await this._read(),result={version:2,owner_device_id:v.owner_device_id,jobs:copy(v.jobs),candidates:[]};for(const c of v.candidates){const {file,...meta}=c;result.candidates.push({...copy(meta),audio:(await this._preview(c)).toString('base64')});}parsePortable(result);return result;});}
 importPortable(bundle){
  // Snapshot before queueing so caller mutation cannot change approved data.
  let incoming,audio;try{audio=parsePortable(bundle);incoming=copy(bundle);}catch(error){return Promise.reject(error);}
  return this._queue(async()=>{
   const current=await this._read(),jobs=new Map(current.jobs.map(j=>[j.id,copy(j)])),candidates=new Map(current.candidates.map(c=>[c.candidate_id,copy(c)]));
   for(const j of incoming.jobs)jobs.set(j.id,jobs.has(j.id)?mergeJob(jobs.get(j.id),j):copy(j));
   const pending=[];
   for(const portable of incoming.candidates){const {audio:encoded,...meta}=portable,c={...meta,file:meta.candidate_id+'.'+meta.format},existing=candidates.get(c.candidate_id);if(existing){if(!(await this._preview(existing)).equals(audio.get(c.candidate_id)))throw schemaError();candidates.set(c.candidate_id,mergeCandidate(existing,c));}else{candidates.set(c.candidate_id,c);pending.push(c);}}
   const merged={version:2,owner_device_id:current.owner_device_id,jobs:[...jobs.values()],candidates:[...candidates.values()]};validateLedger(merged);
   const created=[];try{
    if(pending.length)await fs.mkdir(path.join(this.directory,'voice-previews'),{recursive:true,mode:0o700});
    for(const c of pending){const file=path.join(this.directory,'voice-previews',c.file);try{await fs.writeFile(file,audio.get(c.candidate_id),{flag:'wx',mode:0o600});created.push(file);}catch(error){if(error.code!=='EEXIST'||!(await this._preview(c)).equals(audio.get(c.candidate_id)))throw error;}}
    await this._atomic(this.file,merged);
   }catch(error){for(const file of created)await fs.unlink(file).catch(()=>{});throw error;}
   return {imported:true,candidates:merged.candidates.length,jobs:merged.jobs.length,spending_locked:this._summary(merged,await this._spending()).spending_locked};
  });
 }
}
module.exports={VoiceVault};
