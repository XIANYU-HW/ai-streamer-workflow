'use strict';
const PAGES=new Set(['/overlay.html','/scene-output.html','/standby.html']);
const PUBLIC_RESOURCES=new Set([...PAGES,'/style.css','/motion.css','/avatar.js','/stage-render.js','/overlay.js','/api/public','/api/public-meta','/api/motion','/state.json']);
function parsePublicURL(value){
 if(typeof value!=='string'||value.length>2048)throw Error('PUBLIC_LOOPBACK_URL_REQUIRED');
 let u;try{u=new URL(value);}catch{throw Error('PUBLIC_LOOPBACK_URL_REQUIRED');}
 if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||!u.port||u.username||u.password||u.search||u.hash||!PAGES.has(u.pathname)||u.href!==value)throw Error('PUBLIC_LOOPBACK_URL_REQUIRED');
 return u;
}
function parseOptions(argv=[],env={}){
 let url=null,standbyUrl=null,smoke=false;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--smoke-test'){if(smoke)throw Error('DUPLICATE_ARGUMENT');smoke=true;}
  else if(arg==='--url'||arg==='--standby-url'){
   if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('MISSING_PUBLIC_URL');
   const value=parsePublicURL(argv[++i]).href;
   if(arg==='--url'){if(url)throw Error('DUPLICATE_ARGUMENT');url=value;}
   else{if(standbyUrl)throw Error('DUPLICATE_ARGUMENT');standbyUrl=value;}
  }else throw Error('UNKNOWN_ARGUMENT');
 }
 if(standbyUrl&&(!url||new URL(standbyUrl).origin!==new URL(url).origin))throw Error('STANDBY_ORIGIN_MISMATCH');
 if(smoke&&(url||!env.AI_STREAMER_PROGRAMME_DATA_DIR))throw Error('SMOKE_REQUIRES_ISOLATED_OFFLINE_DATA');
 return Object.freeze({url,standbyUrl,smoke,dataDirectory:env.AI_STREAMER_PROGRAMME_DATA_DIR||null});
}
function createPolicy(config,offline){
 const origin=config.url?new URL(config.url).origin:null;
 const pages=new Set([offline,...[config.url,config.standbyUrl].filter(Boolean)]);
 function publicResource(value){
  if(!origin||typeof value!=='string')return false;
  try{const u=new URL(value);return u.origin===origin&&u.href===value&&!u.username&&!u.password&&!u.search&&!u.hash&&PUBLIC_RESOURCES.has(u.pathname);}catch{return false;}
 }
 function allowNavigation(url){return typeof url==='string'&&pages.has(url);}
 function allowRequest({url,method,resourceType}){
  if(method!=='GET'||['media','webSocket','subFrame'].includes(resourceType))return false;
  if(url===offline)return true;
  if(resourceType==='image'&&typeof url==='string'&&url.length<=3*1024*1024&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url))return true;
  return publicResource(url);
 }
 function allowResponse({url,resourceType,statusCode}){return resourceType!=='mainFrame'||url===offline||(pages.has(url)&&statusCode===200);}
 return Object.freeze({allowNavigation,allowRequest,allowResponse});
}
module.exports={parseOptions,parsePublicURL,createPolicy};
