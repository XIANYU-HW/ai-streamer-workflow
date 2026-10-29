'use strict';
const http=require('node:http');
const crypto=require('node:crypto');

const MAX_BODY=16*1024,MAX_RESPONSE=256*1024;
const ERRORS=Object.freeze({
 BUDGET_STATE_UNKNOWN:[503,'费用记录或模式暂不可用，未重置账本。'],
 INVALID_REQUEST:[400,'请求格式无效。'],BAD_REQUEST:[400,'请求格式无效。'],AUTH_REQUIRED:[401,'需要有效的本机运行能力。'],FORBIDDEN:[403,'此能力不能执行该操作。'],HOST_REJECTED:[403,'仅接受本机固定地址。'],ORIGIN_REJECTED:[403,'浏览器不能调用运行接口。'],NOT_FOUND:[404,'接口不存在。'],METHOD_NOT_ALLOWED:[405,'此接口不支持该方法。'],REQUEST_TIMEOUT:[408,'请求内容接收超时。'],LENGTH_REQUIRED:[411,'需要明确的请求长度。'],BODY_TOO_LARGE:[413,'请求内容超过限制。'],JSON_REQUIRED:[415,'需要 JSON 请求。'],EXPECTATION_REJECTED:[417,'不支持此请求协商。'],CLOSED:[503,'运行接口已关闭。'],
 LEASE_BUSY:[409,'运行租约已被占用。'],LEASE_INVALID:[409,'运行租约已失效。'],STALE_GENERATION:[409,'运行代次已失效。'],SESSION_NOT_READY:[409,'运行会话尚未就绪。'],ROLE_NOT_FOUND:[404,'本场角色不存在。'],SCENE_NOT_FOUND:[404,'所选场景不存在。'],CHARACTER_NOT_FOUND:[404,'所选人物不存在。'],VOICE_NOT_READY:[409,'本场声音尚未就绪。'],QUEUE_FULL:[429,'待播队列已满。'],BUSY:[409,'上一条回答尚未结束。'],PERSONA_MISMATCH:[409,'角色版本与本场资料不一致。'],DEADLINE_EXPIRED:[409,'短句已超过播放期限。'],DUPLICATE_CONFLICT:[409,'事件编号与原请求冲突。'],UTTERANCE_NOT_FOUND:[404,'原话段不存在。'],HISTORY_FULL:[429,'本场事件记录已满。'],STOP_UNCONFIRMED:[503,'尚未确认旧声音停止。'],RENDERER_UNAVAILABLE:[503,'工作室播放器不可用。'],WORKSPACE_UNAVAILABLE:[503,'角色资料暂不可用。'],PLAYBACK_FAILED:[502,'播放器未能完成短句。'],PLAYBACK_ERROR:[503,'播放器未能完成短句。'],INTERNAL_ERROR:[500,'运行接口未能完成请求。']
});
const ROUTES=Object.freeze({
 '/v1/lease':{method:'POST',scopes:['control'],call:'acquireLease'},
 '/v1/heartbeat':{method:'POST',scopes:['control'],call:'renewLease'},
 '/v1/session':{method:'POST',scopes:['control'],call:'openSession'},
 '/v1/enqueue':{method:'POST',scopes:['control','producer'],call:'enqueue'},
 '/v1/append':{method:'POST',scopes:['control','producer'],call:'append'},
 '/v1/cancel':{method:'POST',scopes:['control','producer'],call:'cancel'},
 '/v1/status':{method:'GET',scopes:['control','producer','monitor'],call:'status'},
 '/v1/personas':{method:'GET',scopes:['control','producer'],call:'personas'},
 '/v1/spending':{method:'GET',scopes:['control','producer','monitor'],call:'spendingStatus',optional:true},
 '/v1/spending-mode':{method:'POST',scopes:['control'],call:'configureSpending',optional:true}
});
const STATES=new Set(['idle','dispatching','dispatched','requested','ready','starting','speaking','buffering','completed','failed','cancelled','paused','blocked','stopped']);
const ANSWER_STATES=new Set(['dispatching','queued','awaiting_append','cancelling','unknown']);
const TERMINAL_STATES=new Set(['end','cancel_ack','rejected','unknown']);
const TERMINAL_REASONS=new Set(['COMPLETED','CANCELLED','SESSION_REPLACED']);
const fault=code=>Object.assign(new Error(ERRORS[code]?.[1]||ERRORS.INTERNAL_ERROR[1]),{code});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fields(source,keys,maxText=256){
 if(!object(source))throw fault('INTERNAL_ERROR');const target={};
 for(const key of keys){const value=source[key];if(value!==undefined){if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='string'&&value.length>maxText||typeof value==='number'&&!Number.isFinite(value))throw fault('INTERNAL_ERROR');target[key]=value;}}
 return target;
}
function active(source){if(source===null||source===undefined)return null;const result=fields(source,['dispatch_id','utterance_id','session_id','generation','role_id','character_id','source_event_id','persona_revision','segment_index','final']);if(source.status!==undefined)result.status=STATES.has(source.status)?source.status:'blocked';return result;}
function answer(source){
 if(source==null)return null;
 const result=fields(source,['session_id','generation','role_id','source_event_id','utterance_id','persona_revision','received_at','deadline_at','priority','final','final_segment_index','accepted_segments','completed_segments','next_segment_index']);
 result.status=ANSWER_STATES.has(source.status)?source.status:'unknown';return result;
}
function terminal(source){
 const result=fields(source,['session_id','generation','role_id','source_event_id','utterance_id','persona_revision','final_segment_index','completed_segments']);
 result.status=TERMINAL_STATES.has(source.status)?source.status:'unknown';
 result.reason=typeof source.reason==='string'&&(Object.hasOwn(ERRORS,source.reason)||TERMINAL_REASONS.has(source.reason))?source.reason:'INTERNAL_ERROR';return result;
}
function rendererIdentity(source){
 if(source==null)return null;
 const r=fields(source,['web_contents_id','process_id','incarnation_id']);
 if(!['web_contents_id','process_id'].every(k=>Number.isSafeInteger(r[k])&&r[k]>0)||typeof r.incarnation_id!=='string'||!/^[a-f0-9-]{36}$/.test(r.incarnation_id))throw fault('INTERNAL_ERROR');return r;
}
function rendererTermination(source){
 if(source==null)return null;const r=fields(source,['reason','exit_code','observed_at','backend_cancelled']);r.identity=rendererIdentity(source.identity);
 if(!r.identity||!['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction'].includes(r.reason)||!Number.isSafeInteger(r.exit_code)||!Number.isFinite(r.observed_at)||typeof r.backend_cancelled!=='boolean')throw fault('INTERNAL_ERROR');return r;
}
function stopEvidence(source){
 if(source==null)return null;const r=fields(source,['stop_id','method','confirmed','backend_cancelled','at']);r.renderer_identity=rendererIdentity(source.renderer_identity);
 if(typeof r.stop_id!=='string'||!r.stop_id||!['renderer_stop_ack','renderer_process_terminated','unconfirmed'].includes(r.method)||typeof r.confirmed!=='boolean'||typeof r.backend_cancelled!=='boolean'||!Number.isFinite(r.at)||r.confirmed&&(!r.backend_cancelled||r.method==='unconfirmed')||r.method==='renderer_process_terminated'&&!r.renderer_identity)throw fault('INTERNAL_ERROR');return r;
}
function publicStatus(value){
 if(!object(value))throw fault('INTERNAL_ERROR');
 const result=fields(value,['schema_version','protocol_version','renderer_ready','queue_depth','closed']);
 result.lease=value.lease==null?null:fields(value.lease,['owner','expires_at']);
 if(value.session==null)result.session=null;
 else{result.session=fields(value.session,['session_id','generation','scene_id','mode']);if(!Array.isArray(value.session.roles)||value.session.roles.length>4)throw fault('INTERNAL_ERROR');result.session.roles=value.session.roles.map(r=>fields(r,['role_id','character_id','name','revision','profile_id','voice_id']));}
 result.active=active(value.active);
 result.utterance=answer(value.utterance);
 if(value.receipts!==undefined&&!Array.isArray(value.receipts))throw fault('INTERNAL_ERROR');
 result.receipts=(value.receipts||[]).slice(-64).map(terminal);
 result.last_error=value.last_error==null?null:{code:Object.hasOwn(ERRORS,value.last_error.code)?value.last_error.code:'INTERNAL_ERROR'};
 if(value.renderer!==undefined){
  if(!object(value.renderer)||typeof value.renderer.ready!=='boolean')throw fault('INTERNAL_ERROR');
  result.renderer={ready:value.renderer.ready,playback_status:STATES.has(value.renderer.playback_status)?value.renderer.playback_status:'blocked',active:active(value.renderer.active),last_error:value.renderer.last_error==null?null:Object.hasOwn(ERRORS,value.renderer.last_error)?value.renderer.last_error:'PLAYBACK_ERROR'};
  if(value.renderer.renderer_identity!==undefined)result.renderer.renderer_identity=rendererIdentity(value.renderer.renderer_identity);
  if(value.renderer.termination!==undefined)result.renderer.termination=rendererTermination(value.renderer.termination);
  if(value.renderer.last_stop!==undefined)result.renderer.last_stop=stopEvidence(value.renderer.last_stop);
  if(value.renderer.clean_stop_required!==undefined){if(typeof value.renderer.clean_stop_required!=='boolean')throw fault('INTERNAL_ERROR');result.renderer.clean_stop_required=value.renderer.clean_stop_required;}
 }
 return result;
}
function privatePersonas(value){
 if(!object(value)||!Array.isArray(value.roles)||value.roles.length>4)throw fault('INTERNAL_ERROR');
 const result=fields(value,['session_id','generation','scene_id']);
 result.roles=value.roles.map(role=>({
  ...fields(role,['role_id','character_id','revision','name','driver','backstory','bio','address'],8000),
  traits:fields(role.traits,['calm','stubborn','humor','talkative']),
  voice:fields(role.voice,['profile_id','provider','service','voice_id','local_voice_id','language','description','style','rate','pitch','volume','stability','similarity','expressiveness','sample'],8000)
 }));
 return result;
}
function countHeader(req,name){let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;return count;}
function jsonBody(req,deadline){
 if(req.headers['content-type']!=='application/json'||countHeader(req,'content-type')!==1)throw fault('JSON_REQUIRED');
 if(req.headers['transfer-encoding']!==undefined)throw fault('BAD_REQUEST');
 if(countHeader(req,'content-length')!==1)throw fault('LENGTH_REQUIRED');
 const raw=req.headers['content-length'];if(typeof raw!=='string'||! /^(0|[1-9][0-9]*)$/.test(raw))throw fault('BAD_REQUEST');
 const declared=Number(raw);if(!Number.isSafeInteger(declared)||declared>MAX_BODY)throw fault('BODY_TOO_LARGE');if(declared===0)throw fault('INVALID_REQUEST');
 return new Promise((resolve,reject)=>{
  let length=0,done=false;const chunks=[];
  function cleanup(){clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('aborted',abort);req.removeListener('error',abort);}
  function finish(error,value){if(done)return;done=true;cleanup();error?reject(error):resolve(value);}
  function abort(){finish(fault('BAD_REQUEST'));}
  function data(chunk){length+=chunk.length;if(length>declared||length>MAX_BODY)return finish(fault('BODY_TOO_LARGE'));chunks.push(chunk);}
  function end(){
   if(length!==declared)return finish(fault('BAD_REQUEST'));
   try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!object(value))throw fault('INVALID_REQUEST');finish(null,value);}catch{finish(fault('INVALID_REQUEST'));}
  }
  const timer=setTimeout(()=>finish(fault('REQUEST_TIMEOUT')),deadline);timer.unref();
  req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);
 });
}
function personaQuery(search){
 const values=new URLSearchParams(search);if([...values.keys()].length!==2||values.getAll('session_id').length!==1||values.getAll('generation').length!==1)throw fault('INVALID_REQUEST');
 const session_id=values.get('session_id'),raw=values.get('generation');
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session_id||'')||!/^[1-9][0-9]*$/.test(raw||''))throw fault('INVALID_REQUEST');const generation=Number(raw);if(!Number.isSafeInteger(generation))throw fault('INVALID_REQUEST');return {session_id,generation};
}

async function createRuntimeHttp({runtime,port=0,tokens,bodyTimeoutMs=2000}={}){
 if(!object(runtime)||![...new Set(Object.values(ROUTES).filter(r=>!r.optional).map(r=>r.call))].every(name=>typeof runtime[name]==='function'))throw fault('INVALID_REQUEST');
 if(!object(tokens)||Object.keys(tokens).length!==3||!['control','producer','monitor'].every(k=>typeof tokens[k]==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(tokens[k]))||new Set(Object.values(tokens)).size!==3)throw fault('INVALID_REQUEST');
 if(!Number.isSafeInteger(port)||port<0||port>65535||!Number.isSafeInteger(bodyTimeoutMs)||bodyTimeoutMs<20||bodyTimeoutMs>10000)throw fault('INVALID_REQUEST');
 const tokenHashes=Object.entries(tokens).map(([scope,value])=>[scope,crypto.createHash('sha256').update(value).digest()]);
 let host='',origin='',closed=false,closing;
 function scopeFor(req){
  if(countHeader(req,'authorization')!==1)return null;const value=req.headers.authorization;if(typeof value!=='string'||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(value))return null;
  const digest=crypto.createHash('sha256').update(value.slice(7)).digest();let result=null;for(const [scope,expected] of tokenHashes)if(crypto.timingSafeEqual(digest,expected))result=scope;return result;
 }
 function reply(req,res,status,value){
  if(res.destroyed||res.writableEnded)return;
  let bytes;try{bytes=Buffer.from(JSON.stringify(value));if(bytes.length>MAX_RESPONSE)throw fault('INTERNAL_ERROR');}catch{status=500;bytes=Buffer.from(JSON.stringify({error:{code:'INTERNAL_ERROR',message:ERRORS.INTERNAL_ERROR[1]}}));}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
  res.end(bytes,()=>{if(!req.complete)req.socket.destroy();});
 }
 function reject(req,res,code){const [status,message]=ERRORS[code]||ERRORS.INTERNAL_ERROR;reply(req,res,status,{error:{code:Object.hasOwn(ERRORS,code)?code:'INTERNAL_ERROR',message}});}
 async function handler(req,res){
  try{
   if(closed)throw fault('CLOSED');
   if(countHeader(req,'host')!==1||req.headers.host!==host)throw fault('HOST_REJECTED');
   if(countHeader(req,'origin')>1||req.headers.origin!==undefined&&req.headers.origin!=='')throw fault('ORIGIN_REJECTED');
   const scope=scopeFor(req);if(!scope)throw fault('AUTH_REQUIRED');
   const raw=req.url||'',split=raw.indexOf('?'),pathname=split<0?raw:raw.slice(0,split),search=split<0?'':raw.slice(split+1);const route=ROUTES[pathname];
   if(!route||typeof runtime[route.call]!=='function')throw fault('NOT_FOUND');if(req.method!==route.method)throw fault('METHOD_NOT_ALLOWED');if(!route.scopes.includes(scope))throw fault('FORBIDDEN');
   let input;
   if(route.call==='personas')input=personaQuery(search);
   else if(split>=0)throw fault('INVALID_REQUEST');
   if(req.method==='POST')input=await jsonBody(req,bodyTimeoutMs);
   else if(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')throw fault('INVALID_REQUEST');
   if(closed||req.aborted)throw fault('CLOSED');
   const result=await runtime[route.call](input);
   if(closed||req.aborted)return;reply(req,res,200,route.call==='status'?publicStatus(result):route.call==='personas'?privatePersonas(result):result);
  }catch(error){const code=typeof error?.code==='string'&&Object.hasOwn(ERRORS,error.code)?error.code:'INTERNAL_ERROR';reject(req,res,code);}
 }
 const server=http.createServer({maxHeaderSize:8192,insecureHTTPParser:false},(req,res)=>void handler(req,res));
 server.maxHeadersCount=32;server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1;server.maxRequestsPerSocket=1;
 server.on('checkContinue',(req,res)=>reject(req,res,'EXPECTATION_REJECTED'));
 server.on('checkExpectation',(req,res)=>reject(req,res,'EXPECTATION_REJECTED'));
 server.on('clientError',(_error,socket)=>{if(socket.destroyed||!socket.writable)return;const body=JSON.stringify({error:{code:'BAD_REQUEST',message:ERRORS.BAD_REQUEST[1]}});socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'+body);});
 const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.setTimeout(10000,()=>socket.destroy());});
 await new Promise((resolve,reject)=>{const failed=()=>{server.removeListener('listening',listening);reject(fault('INTERNAL_ERROR'));};const listening=()=>{server.removeListener('error',failed);resolve();};server.once('error',failed);server.once('listening',listening);server.listen({host:'127.0.0.1',port,exclusive:true});});
 port=server.address().port;host='127.0.0.1:'+port;origin='http://'+host;
 function close(){if(closing)return closing;closed=true;closing=new Promise(resolve=>{server.close(resolve);for(const socket of sockets)socket.destroy();});return closing;}
 return Object.freeze({origin,port,close});
}
module.exports={createRuntimeHttp};
