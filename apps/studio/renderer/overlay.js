(function(root){
'use strict';
function createOverlay(env){
  const doc=env.document,canvas=doc.getElementById('canvas'),actors=doc.getElementById('actors'),caption=doc.getElementById('caption'),status=doc.getElementById('status'),stage=env.StudioStage;
  const pending=new Set();
  let running=false,generation=0,connected=false,targetRevision=null,renderedRevision=null,publicTask=null,metaBusy=false,motionBusy=false,metaTimer=null,motionTimer=null,cleared=false,muted=false;
  const empty={schema_version:'overlay1',scene:{name:'',environment:'observatory',accent:'#000000',background_image:null},cast:[],caption:'',talking_id:null,muted:true,mode:'rehearsal'};
  function normalStatus(){status.textContent=muted?'本地演练 · 已静音':'本地演练 · 未开播';}
  function clearStage(){
    if(!cleared){
      stage.resetMotion(actors);
      // Empty paint disposes the renderer's persistent actor records and observers.
      stage.paint(canvas,actors,empty);
      canvas.classList.remove('observatory','lounge','arena');
      canvas.style.backgroundImage='none';canvas.style.backgroundColor='transparent';canvas.style.borderColor='transparent';
      const art=canvas.querySelector('.scene-art');if(art)art.hidden=true;
      cleared=true;
    }
    caption.textContent='';status.textContent='工作室未连接 · 画面已清空';
  }
  function invalidatePublic(){if(publicTask)publicTask.controller.abort();publicTask=null;}
  function disconnect(){
    generation++;connected=false;targetRevision=null;renderedRevision=null;invalidatePublic();clearStage();
  }
  function validMeta(value){return value&&typeof value==='object'&&Number.isSafeInteger(value.revision)&&value.revision>=0&&typeof value.connected==='boolean';}
  async function json(path,controller,timeout){
    const request=controller||new env.AbortController();pending.add(request);let timer;
    try{
      const timed=new Promise((_,reject)=>{timer=env.setTimeout(()=>{request.abort();reject(new Error('Output request timed out'));},timeout);});
      const read=(async()=>{const response=await env.fetch(path,{cache:'no-store',credentials:'same-origin',signal:request.signal});if(!response.ok)throw new Error('Output request failed');return response.json();})();
      return await Promise.race([read,timed]);
    }finally{env.clearTimeout(timer);pending.delete(request);}
  }
  function scheduleMeta(delay=500){env.clearTimeout(metaTimer);if(running)metaTimer=env.setTimeout(()=>{metaTimer=null;void pollMeta();},delay);}
  function scheduleMotion(delay=100){env.clearTimeout(motionTimer);if(running)motionTimer=env.setTimeout(()=>{motionTimer=null;void pollMotion();},delay);}
  function acceptMeta(meta){
    if(!validMeta(meta))throw new Error('Invalid public metadata');
    if(!meta.connected){disconnect();return;}
    if(!connected||targetRevision!==meta.revision){
      connected=true;targetRevision=meta.revision;generation++;invalidatePublic();
      void loadPublic(meta.revision,generation);
    }else if(renderedRevision!==meta.revision&&!publicTask){void loadPublic(meta.revision,generation);}
  }
  async function loadPublic(revision,token){
    const task={revision,token,controller:new env.AbortController()};publicTask=task;
    try{
      const payload=await json('/api/public',task.controller,5000);
      if(!running||token!==generation||publicTask!==task)return;
      // A large image download can finish after disconnect/release. Recheck the
      // small metadata before committing it, even if the main poll has not run yet.
      const check=await json('/api/public-meta',null,2000);
      if(!running||token!==generation||publicTask!==task)return;
      if(!validMeta(check))throw new Error('Invalid public metadata');
      if(!check.connected||check.revision!==revision){acceptMeta(check);return;}
      if(!payload||payload.schema_version!=='overlay1'||!payload.scene||!Array.isArray(payload.cast)||payload.cast.length>4||typeof payload.caption!=='string')throw new Error('Invalid public stage');
      canvas.style.backgroundColor='';stage.paint(canvas,actors,payload);
      caption.textContent=payload.caption;muted=payload.muted===true;normalStatus();
      renderedRevision=revision;cleared=false;scheduleMotion(0);
    }catch{
      if(running&&token===generation&&publicTask===task)disconnect();
    }finally{if(publicTask===task)publicTask=null;}
  }
  async function pollMeta(){
    if(!running||metaBusy){if(running)scheduleMeta();return;}
    metaBusy=true;const token=generation;
    try{const meta=await json('/api/public-meta',null,2000);if(running&&token===generation)acceptMeta(meta);}
    catch{if(running&&token===generation)disconnect();}
    finally{metaBusy=false;scheduleMeta();}
  }
  async function pollMotion(){
    if(!running||motionBusy||!connected||renderedRevision!==targetRevision||doc.hidden){if(running)scheduleMotion();return;}
    motionBusy=true;const token=generation,revision=renderedRevision;
    try{
      const packet=await json('/api/motion',null,1500);
      if(!running||token!==generation||!connected||revision!==renderedRevision||doc.hidden)return;
      if(packet===null)stage.resetMotion(actors);
      // Keep the producer's wall-clock timestamps: StudioStage applies the
      // remaining gesture phase instead of restarting gestures in each window.
      else stage.setMotion(actors,packet);
      normalStatus();
    }catch{
      if(running&&token===generation&&connected){stage.resetMotion(actors);status.textContent='本地演练 · 动作同步暂不可用';}
    }finally{motionBusy=false;scheduleMotion();}
  }
  function onVisibility(){
    if(!running)return;
    if(doc.hidden)stage.resetMotion(actors);
    else{scheduleMeta(0);scheduleMotion(0);}
  }
  function start(){if(running)return;running=true;doc.addEventListener('visibilitychange',onVisibility);scheduleMeta(0);scheduleMotion(0);}
  function stop(){
    if(!running)return;running=false;generation++;connected=false;invalidatePublic();env.clearTimeout(metaTimer);env.clearTimeout(motionTimer);
    pending.forEach(controller=>controller.abort());pending.clear();doc.removeEventListener('visibilitychange',onVisibility);clearStage();
  }
  return{start,stop,refresh(){if(running){scheduleMeta(0);scheduleMotion(0);}}};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createOverlay};
else{const output=createOverlay(root);output.start();root.addEventListener('pagehide',()=>output.stop());root.addEventListener('pageshow',()=>output.start());}
})(typeof globalThis!=='undefined'?globalThis:this);
