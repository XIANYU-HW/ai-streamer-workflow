'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');
const {performance}=require('node:perf_hooks');
const {NativeSpeech}=require('./local-speech.cjs');
const APP_VERSION=require('./package.json').version;
const ASSETS=new Map();
for(const name of ['index.html','welcome.html','welcome.js','scene-output.html','overlay.html','style.css','motion.css','app.js','storage.js','model.js','avatar.js','stage-render.js','overlay.js','local-audio.js','cloud-audio.js','audio-router.js','voice-studio.js','desktop-ui.js','desktop.css','live-runtime.js'])ASSETS.set(name,name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function exact(v,fields){const keys=fields?fields.split(' '):[];if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))throw fail('字段缺失或含有不支持的字段。');}
function string(v,max){if(typeof v!=='string'||v.length>max)throw fail('文本格式无效。');}
function number(v,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw fail('数字范围无效。');}
function color(v){if(typeof v!=='string'||!/^#[a-fA-F0-9]{6}$/.test(v))throw fail('颜色格式无效。');}
function picture(v){if(v!==null&&(typeof v!=='string'||v.length>2800000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)))throw fail('图片格式无效。');}
function validatePublic(v){
  exact(v,'schema_version scene cast caption talking_id muted mode');if(v.schema_version!=='overlay1'||v.mode!=='rehearsal'||typeof v.muted!=='boolean')throw fail('公开模式无效。');
  const s=v.scene;exact(s,'name environment accent background_image');string(s.name,60);color(s.accent);picture(s.background_image);if(!['observatory','lounge','arena'].includes(s.environment))throw fail('场景无效。');
  if(!Array.isArray(v.cast)||v.cast.length>4)throw fail('阵容无效。');const ids=new Set();
  for(const c of v.cast){
    exact(c,'character_id name role appearance x y');string(c.character_id,80);string(c.name,30);if(ids.has(c.character_id))throw fail('角色重复。');ids.add(c.character_id);
    if(!['主持','搭档','嘉宾','解说','玩家'].includes(c.role))throw fail('岗位无效。');number(c.x,0,80);number(c.y,0,65);
    const a=c.appearance;exact(a,'primary accent image size emotion mouth'+(a&&Object.hasOwn(a,'motion')?' motion':''));color(a.primary);color(a.accent);picture(a.image);number(a.size,12,32);if(!['平静','专注','疑惑','惊讶','得意','懊恼'].includes(a.emotion)||typeof a.mouth!=='boolean')throw fail('表情无效。');
    if(Object.hasOwn(a,'motion')){const m=a.motion;exact(m,'enabled intensity mouth_image mouth');if(typeof m.enabled!=='boolean')throw fail('动作状态无效。');number(m.intensity,0,1);picture(m.mouth_image);exact(m.mouth,'x y width height');number(m.mouth.x,0,100);number(m.mouth.y,0,100);number(m.mouth.width,1,30);number(m.mouth.height,1,20);}
  }
  if(v.talking_id!==null&&!ids.has(v.talking_id))throw fail('说话角色不在场。');string(v.caption,400);return v;
}
function validateMotion(v){
  exact(v,'epoch seq cast updated_at');string(v.epoch,80);if(!v.epoch||!Number.isSafeInteger(v.seq)||v.seq<0)throw fail('动作标识无效。');number(v.updated_at,0,Date.now()+60000);
  if(!Array.isArray(v.cast)||v.cast.length>4)throw fail('动作阵容无效。');const ids=new Set();
  for(const c of v.cast){exact(c,'character_id mouth energy gesture gesture_at');string(c.character_id,80);if(ids.has(c.character_id))throw fail('动作角色重复。');ids.add(c.character_id);number(c.mouth,0,1);number(c.energy,0,1);number(c.gesture_at,0,Date.now()+60000);if(!['idle','nod','shake','happy','greet'].includes(c.gesture))throw fail('动作无效。');}return v;
}
function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
const CLOUD_ERRORS={SPENDING_LOCKED:[403,'付费语音默认关闭，请在本机声音设置中明确启用并设置预算。'],BUDGET_STATE_UNKNOWN:[503,'声音费用记录暂不可用，未发送新请求；累计记录没有清零。'],INSUFFICIENT_BALANCE:[402,'MiniMax账户余额不足；本软件不会自动充值。'],BUDGET_EXCEEDED:[402,'本次语音会超过已设置的预算，请调整预算后重试。'],MISSING_KEY:[503,'请先在声音设置中保存云语音密钥。'],KEYCHAIN_TIMEOUT:[503,'系统密钥授权仍未完成；请本人处理 macOS 钥匙串授权，或在声音设置中重新保存密钥。未发送语音请求。'],VOICE_NOT_READY:[409,'此角色的云音色尚未就绪，请先设置音色。'],BUSY:[429,'上一段语音仍在准备，请稍候重试。'],CANCELLED:[409,'云语音请求已取消。'],INVALID_REQUEST:[400,'云语音参数无效，请检查声音设置。'],PROVIDER_ERROR:[502,'云语音服务返回错误，请检查账户与设置。'],NETWORK_ERROR:[502,'无法连接云语音服务，请稍后重试。'],HTTP_ERROR:[502,'云语音服务未能接受请求，请检查账户与设置。'],MALFORMED_RESPONSE:[502,'云语音服务返回了无法识别的数据。'],RESPONSE_TOO_LARGE:[502,'云语音数据超过本地限制。'],INCOMPLETE_STREAM:[502,'云语音连接提前结束，未确认合成完成。']};
function cloudError(error,cancelled=false){const code=cancelled?'CANCELLED':Object.hasOwn(CLOUD_ERRORS,error?.code)?error.code:'PROVIDER_ERROR';const [status,message]=CLOUD_ERRORS[code];return {status,value:{type:'error',code,error:message}};}
function cloudEvent(value){
  if(!value||typeof value!=='object')throw fail('云语音数据无效。',502);
  if(value.type==='audio'){
    if(value.format!=='mp3'||typeof value.audio!=='string'||value.audio.length<4||value.audio.length>2*1024*1024||value.audio.length%4!==0||!/[A-Za-z0-9+/]/.test(value.audio)||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio))throw fail('云语音数据无效。',502);
    return {type:'audio',audio:value.audio,format:'mp3'};
  }
  if(value.type==='done'){
    const unknown=value.cost_unknown===true;
    if(value.format!=='mp3'||value.cost_unknown!==undefined&&typeof value.cost_unknown!=='boolean'||typeof value.first_audio_byte_ms!=='number'||!Number.isFinite(value.first_audio_byte_ms)||value.first_audio_byte_ms<0)throw fail('云语音完成信息无效。',502);
    // Only the budget manager may emit this explicit missing-usage terminal.
    // Preserve unknown values instead of implying a zero-cost provider call.
    if(unknown){
      if(value.usage_characters!==null||value.estimated_cost_usd!==null)throw fail('云语音费用信息无效。',502);
      return {type:'done',usage_characters:null,estimated_cost_usd:null,cost_unknown:true,first_audio_byte_ms:value.first_audio_byte_ms,format:'mp3'};
    }
    if(!Number.isSafeInteger(value.usage_characters)||value.usage_characters<0)throw fail('云语音完成信息无效。',502);
    const event={type:'done',usage_characters:value.usage_characters,first_audio_byte_ms:value.first_audio_byte_ms,format:'mp3'};
    if(value.estimated_cost_usd!==undefined){if(typeof value.estimated_cost_usd!=='number'||!Number.isFinite(value.estimated_cost_usd)||value.estimated_cost_usd<0)throw fail('云语音费用信息无效。',502);event.estimated_cost_usd=value.estimated_cost_usd;}
    return event;
  }
  throw fail('云语音事件无效。',502);
}
async function readJSON(req,limit){
  const declared=Number(req.headers['content-length']);if(!Number.isSafeInteger(declared)||declared<=0||declared>limit)throw fail('请求内容为空或超过限制。',413);
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>limit)throw fail('请求超过限制。',413);chunks.push(chunk);}
  if(length!==declared)throw fail('请求内容不完整。');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw fail('JSON 内容无效。');}
}
async function createLocalService({root,port=0,token,speech=new NativeSpeech({root}),cloud,clock=()=>performance.now()/1000}={}){
  if(typeof root!=='string'||typeof token!=='string'||token.length<16)throw new Error('本地服务需要资源目录和独立桌面令牌。');
  root=await fs.realpath(root);
  let origin='',host='',leaseOwner=null,leaseUntil=0,publicState=null,publicRevision=0,publicUpdated=0,motionState=null,motionUpdated=0,closing=false,speechEpoch=0,activeSpeech=null,cancelBarrier=Promise.resolve();
  const clearPublic=()=>{publicState=null;motionState=null;publicRevision++;};
  function cancelSpeech(){
    speechEpoch++;
    const job=activeSpeech;job?.controller.abort();
    // Cloud cancellation must begin immediately, even while an earlier native
    // cancellation is still draining. It also stops a concurrent voice design.
    let cloudCancellation;try{cloudCancellation=Promise.resolve(cloud?.cancel?.());}catch{cloudCancellation=Promise.reject(fail('尚未确认云语音已停止。',503));}cloudCancellation.catch(()=>{});
    cancelBarrier=cancelBarrier.catch(()=>{}).then(async()=>{const results=await Promise.allSettled([Promise.resolve().then(()=>speech.cancel?.()),cloudCancellation]);if(job)await job.done;if(results.some(r=>r.status==='rejected'))throw fail('尚未确认语音已停止，请重试。',503);return {cancelled:true};});
    return cancelBarrier;
  }
  function expireLease(){
    if(leaseOwner&&leaseUntil<=clock()){leaseOwner=null;leaseUntil=0;clearPublic();void cancelSpeech().catch(()=>{});}
  }
  const owns=req=>leaseOwner!==null&&req.headers['x-studio-lease']===leaseOwner&&leaseUntil>clock();
  const trusted=req=>sameToken(req.headers['x-studio-desktop'],token);
  function reply(res,status,value,type='application/json; charset=utf-8'){
    if(res.destroyed||res.writableEnded)return;const bytes=Buffer.isBuffer(value)?value:Buffer.from(type.startsWith('application/json')?JSON.stringify(value):String(value));
    res.writeHead(status,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':CSP});res.end(bytes);
  }
  async function handler(req,res){
    try{
      expireLease();if(closing)return reply(res,503,{error:'工作室正在退出。'});
      if(req.headers.host!==host)return reply(res,403,{error:'Host rejected'});
      if(req.method==='GET'){
        if(req.url==='/api/public')return reply(res,200,leaseOwner&&clock()-publicUpdated<5?publicState:null);
        if(req.url==='/api/public-meta')return reply(res,200,{revision:publicRevision,connected:!!(leaseOwner&&publicState&&clock()-publicUpdated<5&&leaseUntil>clock())});
        if(req.url==='/api/motion')return reply(res,200,leaseOwner&&clock()-motionUpdated<1.2?motionState:null);
        if(req.url==='/api/local-voices'){
          if(!trusted(req))return reply(res,403,{error:'Desktop session required'});
          await cancelBarrier;try{return reply(res,200,{voices:await speech.voices(),engine:speech.engine,capabilities:speech.capabilities});}catch(e){return reply(res,503,{error:e.message,capabilities:speech.capabilities});}
        }
        if(req.url==='/api/health'){
          let ready=false;try{await cancelBarrier;ready=(await speech.voices()).length>0;}catch{}
          return reply(res,200,{version:APP_VERSION,mode:'rehearsal',desktop:true,platform:process.platform,local_audio:ready,engine:speech.engine,capabilities:speech.capabilities});
        }
        const name=req.url==='/'?'index.html':req.url.slice(1);if(!ASSETS.has(name))return reply(res,404,{error:'Not found'});
        const file=path.join(root,name);let stat;try{stat=await fs.lstat(file);}catch{return reply(res,404,{error:'Not found'});}
        if(stat.isSymbolicLink()||!stat.isFile()||path.dirname(await fs.realpath(file))!==root)return reply(res,403,{error:'Asset rejected'});
        return reply(res,200,await fs.readFile(file),ASSETS.get(name));
      }
      if(req.method!=='POST')return reply(res,405,{error:'Method not allowed'});
      if(req.headers.origin!==origin||!trusted(req))return reply(res,403,{error:'Desktop origin required'});
      if(req.headers['content-type']!=='application/json')return reply(res,415,{error:'JSON required'});
      if(req.url==='/api/lease'||req.url==='/api/release'){
        const v=await readJSON(req,199);exact(v,'owner');if(typeof v.owner!=='string'||!/^[a-f0-9-]{36}$/.test(v.owner))throw fail('编辑者标识无效。');expireLease();
        if(req.url==='/api/release'){
          if(leaseOwner===v.owner){leaseOwner=null;leaseUntil=0;clearPublic();await cancelSpeech();}
        }else{
          if(leaseOwner&&leaseOwner!==v.owner)return reply(res,409,{error:'editor_in_use'});
          if(leaseOwner===v.owner&&publicState)publicUpdated=clock();
          if(leaseOwner!==v.owner){clearPublic();leaseOwner=v.owner;leaseUntil=clock()+7;await cancelSpeech();}
          if(closing)return reply(res,503,{error:'工作室正在退出。'});
          if(leaseOwner!==v.owner)return reply(res,409,{error:'编辑连接已失效。'});
          leaseOwner=v.owner;leaseUntil=clock()+7;
        }
        return reply(res,200,{ok:true});
      }
      if(!['/api/public','/api/motion','/api/local-audio','/api/cloud-audio','/api/local-audio/cancel'].includes(req.url))return reply(res,404,{error:'Not found'});
      if(!owns(req))return reply(res,409,{error:'编辑连接已失效。'});
      if(req.url==='/api/local-audio/cancel'){
        exact(await readJSON(req,200),'');await cancelSpeech();return reply(res,200,{ok:true,cancelled:true});
      }
      if(req.url==='/api/local-audio'||req.url==='/api/cloud-audio'){
        const isCloud=req.url==='/api/cloud-audio';
        if(activeSpeech)return reply(res,429,{code:'BUSY',error:'上一段音频仍在准备，请稍候重试。'});
        const requestedEpoch=speechEpoch,requestBarrier=cancelBarrier;
        const v=await readJSON(req,isCloud?60000:20000);
        if(isCloud){exact(v,'text voice_id model rate pitch volume character_id profile_id');if(typeof cloud?.stream!=='function'){const error=cloudError({code:'VOICE_NOT_READY'});return reply(res,error.status,error.value);}}
        await requestBarrier;
        if(!owns(req)||requestedEpoch!==speechEpoch||closing)throw fail('语音请求已取消。',409);
        if(activeSpeech)return reply(res,429,{code:'BUSY',error:'上一段音频仍在准备，请稍候重试。'});
        // Recheck and reserve after asynchronous body/barrier reads. Cancellation
        // must never wait for a job that is itself awaiting that cancellation.
        let doneResolve;const job={epoch:speechEpoch,controller:new AbortController(),done:new Promise(r=>doneResolve=r)};activeSpeech=job;
        const onClose=()=>{if(!res.writableEnded&&activeSpeech===job)void cancelSpeech().catch(()=>{});};res.on('close',onClose);
        try{
          if(!owns(req)||job.epoch!==speechEpoch||closing)throw fail('语音请求已取消。',409);
          if(isCloud){
            let terminal=false,audioBytes=0;
            const current=()=>activeSpeech===job&&owns(req)&&job.epoch===speechEpoch&&!closing&&!job.controller.signal.aborted&&!res.destroyed&&!res.writableEnded;
            const onEvent=async value=>{
              if(!current())throw Object.assign(new Error('云语音请求已取消。'),{code:'CANCELLED'});
              if(terminal)throw fail('云语音已经结束。',502);
              const event=cloudEvent(value);if(event.type==='audio'){audioBytes+=Buffer.byteLength(event.audio,'base64');if(audioBytes>64*1024*1024)throw fail('云语音数据超过限制。',502);}else{if(!audioBytes)throw fail('云语音没有音频。',502);terminal=true;}
              if(!res.headersSent)res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':CSP,'X-Studio-Audio-Engine':'minimax_cloud'});
              if(!res.write(JSON.stringify(event)+'\n'))await once(res,'drain',{signal:job.controller.signal});
              if(!current())throw Object.assign(new Error('云语音请求已取消。'),{code:'CANCELLED'});
            };
            let rejectAbort;const aborted=new Promise((_,reject)=>rejectAbort=reject);aborted.catch(()=>{});
            const abort=()=>rejectAbort(Object.assign(new Error('云语音请求已取消。'),{code:'CANCELLED'}));job.controller.signal.addEventListener('abort',abort,{once:true});
            try{
              await Promise.race([Promise.resolve().then(()=>cloud.stream(v,{signal:job.controller.signal,onEvent})),aborted]);
              if(!current())throw Object.assign(new Error('云语音请求已取消。'),{code:'CANCELLED'});
              if(!terminal)throw Object.assign(new Error('云语音连接提前结束。'),{code:'INCOMPLETE_STREAM'});
              res.end();return;
            }catch(error){
              const safe=cloudError(error,!current());
              if(!res.headersSent)return reply(res,safe.status,safe.value);
              if(!res.destroyed&&!res.writableEnded){if(!terminal)res.write(JSON.stringify(safe.value)+'\n');res.end();}return;
            }finally{job.controller.signal.removeEventListener('abort',abort);}
          }
          const wav=await speech.synthesize(v);
          if(!owns(req)||job.epoch!==speechEpoch||closing)throw fail('语音请求已取消。',409);
          res.setHeader('X-Studio-Audio-Engine',speech.engine||'unavailable');
          return reply(res,200,wav,'audio/wav');
        }catch(e){return reply(res,e.status||(e.code==='INVALID_REQUEST'?400:e.code==='CANCELLED'?409:503),{error:e.message});}
        finally{res.removeListener('close',onClose);if(activeSpeech===job)activeSpeech=null;doneResolve();}
      }
      if(req.url==='/api/motion'){
        const value=validateMotion(await readJSON(req,4096));if(!owns(req))return reply(res,409,{error:'编辑连接已失效。'});
        const ids=new Set((publicState?.cast||[]).map(c=>c.character_id));if(value.cast.some(c=>!ids.has(c.character_id)))return reply(res,409,{error:'动作角色不在公开场景中。'});
        if(motionState&&value.epoch===motionState.epoch&&value.seq<=motionState.seq)return reply(res,409,{error:'动作序号已过期。'});
        motionState=value;motionUpdated=clock();return reply(res,200,{ok:true});
      }
      const value=validatePublic(await readJSON(req,32*1024*1024));if(!owns(req))return reply(res,409,{error:'编辑连接已失效。'});
      publicState=value;publicUpdated=clock();publicRevision++;const ids=new Set(value.cast.map(c=>c.character_id));if(motionState?.cast.some(c=>!ids.has(c.character_id)))motionState=null;return reply(res,200,{ok:true});
    }catch(e){if(!req.complete)req.resume();reply(res,e.status||500,{error:e.status?e.message:'本地服务无法完成请求。'});}
  }
  const server=http.createServer((req,res)=>void handler(req,res));server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve);});
  const assigned=server.address().port;host='127.0.0.1:'+assigned;origin='http://'+host;
  const sweep=setInterval(expireLease,250);sweep.unref();
  let closePromise;
  async function close(){
    if(closePromise)return closePromise;closing=true;leaseOwner=null;leaseUntil=0;clearPublic();clearInterval(sweep);
    closePromise=(async()=>{await cancelSpeech();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});})();return closePromise;
  }
  async function revokeEditor(){leaseOwner=null;leaseUntil=0;clearPublic();await cancelSpeech();}
  return {server,origin,port:assigned,close,cancelSpeech,revokeEditor,hasEditorLease(owner){expireLease();return typeof owner==='string'&&leaseOwner===owner&&leaseUntil>clock()&&!closing;},async invalidatePublic(){clearPublic();await cancelSpeech();}};
}
module.exports={createLocalService,validatePublic,validateMotion};
