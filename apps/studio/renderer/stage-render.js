(function(root){
'use strict';
const stages=new WeakMap(),MOTION_TTL=1500;
const gestures={nod:{duration:760,label:'点头'},shake:{duration:840,label:'摇头'},happy:{duration:950,label:'开心'},greet:{duration:1150,label:'招呼'}};
const clamp=(v,min,max,fallback=0)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):fallback;
const node=(tag,cls)=>{const el=document.createElement(tag);if(cls)el.className=cls;return el;};
function motionOf(a){const m=a.motion||{},b=m.mouth||{};return{enabled:m.enabled===true,intensity:clamp(m.intensity,0,1,.65),mouth_image:m.mouth_image||null,mouth:{x:clamp(b.x,0,100,50),y:clamp(b.y,0,100,15),width:clamp(b.width,1,30,8),height:clamp(b.height,1,20,3)}};}
function publicAppearance(a){return{primary:a.primary,accent:a.accent,image:a.image||null,size:a.size,emotion:a.emotion,mouth:a.mouth,motion:motionOf(a)};}
function portrait(c){const a=c.appearance;if(a.image){const img=node('img');img.src=a.image;img.alt=c.name;return img;}return root.StudioRender.avatar({name:c.name,appearance:{...a,state:a.emotion}},false);}
function publicScene(scene,characters,caption='',talkingId=null,muted=false){
  return{schema_version:'overlay1',scene:{name:scene.name,environment:scene.environment,accent:scene.accent,background_image:scene.background_image},cast:characters.map((c,i)=>{const p=scene.placements?.find(x=>x.character_id===c.character_id);return{character_id:c.character_id,name:c.name,role:p?.role||(['主持','搭档','嘉宾','嘉宾'][i]),appearance:publicAppearance(c.appearance),x:p?.x??(characters.length===1?40:characters.length===2?[8,72][i]:[4,28,52,76][i]),y:p?.y??52};}),caption:String(caption).slice(0,400),talking_id:characters.some(c=>c.character_id===talkingId)?talkingId:null,muted:!!muted,mode:'rehearsal'};
}
function stateFor(container){let s=stages.get(container);if(!s){s={actors:new Map(),epoch:null,seq:-1,latestAt:-1,resetAt:-1,retired:new Set(),muted:false,timer:null,environment:null};stages.set(container,s);}return s;}
function clearGesture(a){clearTimeout(a.gestureTimer);a.gestureTimer=null;a.gestureKey=null;a.el.dataset.gesture='idle';a.pose.textContent='';if(a.gesture){a.gesture.style.animationName='none';a.gesture.style.animationDelay='0ms';}}
function gesture(a,name,at,now){
  const spec=gestures[name];
  if(!spec||!a.motion.enabled||a.motion.intensity===0||a.state.muted||!Number.isFinite(at)||at>now+500||now-at>=spec.duration){clearGesture(a);return;}
  const key=name+':'+at;if(a.gestureKey===key)return;
  clearGesture(a);a.gestureKey=key;a.el.dataset.gesture=name;a.pose.textContent=' · '+spec.label;
  a.gesture.style.animationName='none';void a.gesture.offsetWidth;
  a.gesture.style.animationDuration=spec.duration+'ms';a.gesture.style.animationDelay=-Math.max(0,now-at)+'ms';a.gesture.style.animationName='studio-'+name;
  a.gestureTimer=setTimeout(()=>{if(a.gestureKey===key)clearGesture(a);},Math.max(0,spec.duration-(now-at)));
}
function fit(a){
  if(!a.base||!a.base.naturalWidth||!a.base.naturalHeight)return;
  const w=a.area.clientWidth,h=a.area.clientHeight;if(!w||!h)return;
  const scale=Math.min(w/a.base.naturalWidth,h/a.base.naturalHeight);
  a.frame.style.width=(a.base.naturalWidth*scale)+'px';a.frame.style.height=(a.base.naturalHeight*scale)+'px';
  a.mouthReady=!!(a.mouthImage&&a.mouthImage.complete&&a.mouthImage.naturalWidth===a.base.naturalWidth&&a.mouthImage.naturalHeight===a.base.naturalHeight);
  a.el.dataset.mouthReady=String(a.mouthReady);applyMouth(a);
}
function applyMouth(a){
  const active=!a.state.muted&&a.motion.enabled,amount=active?clamp(a.runtime.mouth,0,1):0,open=amount>.05&&a.mouthReady;
  a.el.dataset.mouthOpen=String(!!open);a.el.classList.toggle('motion-enabled',active&&a.motion.intensity>0);a.el.classList.toggle('motion-speaking',active&&amount>.05);a.el.classList.toggle('talking',!a.state.muted&&(amount>.05||a.legacyTalking));
  if(a.mask){a.mask.hidden=!open;a.mask.style.setProperty('--mouth-scale',String(.4+.6*amount));}
  a.el.style.setProperty('--speech-energy',String(active?clamp(a.runtime.energy,0,1):0));
  a.el.style.setProperty('--sway-angle',(.65*a.motion.intensity*(.35+.65*clamp(a.runtime.energy,0,1)))+'deg');
  if(a.vectorStill){const speaking=!a.state.muted&&a.legacyTalking;a.vectorStill.toggleAttribute('hidden',speaking);a.vectorTalking.toggleAttribute('hidden',!speaking);}
}
function idle(a){a.runtime={mouth:0,energy:0,gesture:'idle',gesture_at:0};clearGesture(a);applyMouth(a);}
function disposeBody(a){a.observer?.disconnect();a.observer=null;clearGesture(a);if(a.base){a.base.onload=null;a.base.onerror=null;}if(a.mouthImage){a.mouthImage.onload=null;a.mouthImage.onerror=null;}a.mouthReady=false;}
function buildBody(a,c){
  disposeBody(a);a.motion=motionOf(c.appearance);a.base=null;a.mouthImage=null;a.mask=null;a.vectorStill=null;a.vectorTalking=null;
  a.area=node('div','motion-art-area');a.frame=node('div','motion-frame');a.gesture=node('div','motion-gesture');const breath=node('div','motion-breath'),sway=node('div','motion-sway');
  a.gesture.append(breath);breath.append(sway);a.frame.append(a.gesture);a.area.append(a.frame);a.el.replaceChildren(a.area,a.label);breath.style.animationDelay=-(Date.now()%3700)+'ms';
  const intensity=a.motion.intensity,vars={'--breath-lift':(-1.8*intensity)+'px','--breath-scale':String(1+.008*intensity),'--sway-angle':(.65*intensity)+'deg','--nod-lift':(4*intensity)+'px','--nod-scale':String(1-.025*intensity),'--shake-shift':(5*intensity)+'px','--happy-lift':(-10*intensity)+'px','--greet-angle':(4*intensity)+'deg'};
  Object.entries(vars).forEach(([k,v])=>a.el.style.setProperty(k,v));
  if(c.appearance.image){
    a.base=portrait(c);a.base.className='motion-base';a.base.draggable=false;sway.append(a.base);
    if(a.motion.mouth_image){
      a.mask=node('div','motion-mouth-mask');a.mask.hidden=true;a.mask.setAttribute('aria-hidden','true');const b=a.motion.mouth;
      a.mask.style.clipPath='ellipse('+(b.width/2)+'% '+(b.height/2)+'% at '+b.x+'% '+b.y+'%)';
      a.mouthImage=node('img','motion-mouth-image');a.mouthImage.alt='';a.mouthImage.draggable=false;a.mouthImage.style.transformOrigin=b.x+'% '+b.y+'%';a.mouthImage.src=a.motion.mouth_image;
      a.mask.append(a.mouthImage);sway.append(a.mask);a.mouthImage.onload=()=>fit(a);a.mouthImage.onerror=()=>{a.mouthReady=false;applyMouth(a);};
    }
    a.base.onload=()=>fit(a);a.base.onerror=()=>{a.mouthReady=false;applyMouth(a);};
    if(typeof root.ResizeObserver==='function'){a.observer=new root.ResizeObserver(()=>fit(a));a.observer.observe(a.area);}
    fit(a);
  }else{
    a.frame.classList.add('motion-vector');a.vectorStill=portrait(c);a.vectorTalking=root.StudioRender.avatar({name:c.name,appearance:{...c.appearance,state:c.appearance.emotion}},true);a.vectorTalking.setAttribute('hidden','');sway.append(a.vectorStill,a.vectorTalking);
  }
  applyMouth(a);
}
function signature(c){const a=c.appearance,m=motionOf(a),b=m.mouth;return[a.primary,a.accent,a.image,a.emotion,a.mouth,m.enabled,m.intensity,m.mouth_image,b.x,b.y,b.width,b.height];}
function sameSignature(a,b){return a&&a.length===b.length&&a.every((v,i)=>v===b[i]);}
function makeActor(state,c){const el=node('div','stage-actor'),label=node('span','actor-label'),name=node('span','actor-name'),pose=node('span','actor-pose');label.append(name,pose);el.dataset.characterId=c.character_id;el.dataset.gesture='idle';return{el,label,name,pose,state,signature:null,runtime:{mouth:0,energy:0,gesture:'idle',gesture_at:0},legacyTalking:false,motion:motionOf(c.appearance)};}
function paint(canvas,container,payload){
  const state=stateFor(container),scene=payload.scene;
  canvas.classList.add('stage');if(state.environment)canvas.classList.remove(state.environment);canvas.classList.add(scene.environment);state.environment=scene.environment;
  canvas.style.borderColor=scene.accent+'66';canvas.style.backgroundImage=scene.background_image?'url('+scene.background_image+')':'';canvas.style.backgroundSize='cover';canvas.style.backgroundPosition='center';const art=canvas.querySelector('.scene-art');if(art)art.hidden=!!scene.background_image;
  state.muted=!!payload.muted;const keep=new Set(payload.cast.map(c=>c.character_id));
  for(const [id,a] of state.actors)if(!keep.has(id)){disposeBody(a);a.el.remove();state.actors.delete(id);}
  payload.cast.forEach((c,i)=>{
    let a=state.actors.get(c.character_id);if(!a){a=makeActor(state,c);state.actors.set(c.character_id,a);}
    a.legacyTalking=payload.talking_id===c.character_id&&!state.muted;
    a.el.classList.toggle('raster-actor',!!c.appearance.image);a.el.style.left=c.x+'%';a.el.style.top=c.y+'%';a.el.style.width=Math.min(payload.cast.length>2?22:26,c.appearance.size)+'%';a.el.style.height=c.appearance.image?Math.min(75,87-c.y)+'%':'';
    const sig=signature(c);if(!sameSignature(a.signature,sig)){a.signature=sig;buildBody(a,c);}
    a.name.textContent=c.name+' · '+c.role;if(a.base)a.base.alt=c.name;
    if(state.muted)idle(a);else applyMouth(a);
    const at=container.children[i];if(at!==a.el)container.insertBefore(a.el,at||null);fit(a);
  });
}
function clearMotion(state){clearTimeout(state.timer);state.timer=null;for(const a of state.actors.values()){a.legacyTalking=false;idle(a);}}
function resetMotion(container){const state=stages.get(container);if(!state)return;state.resetAt=Date.now();clearMotion(state);}
function setMotion(container,packet){
  const state=stateFor(container);
  if(!packet||typeof packet.epoch!=='string'||!packet.epoch||packet.epoch.length>160||!Number.isSafeInteger(packet.seq)||packet.seq<0||!Array.isArray(packet.cast)||packet.cast.length>4||typeof packet.updated_at!=='number'||!Number.isFinite(packet.updated_at)||packet.updated_at<0)return false;
  if(state.retired.has(packet.epoch)||state.epoch===packet.epoch&&packet.seq<=state.seq)return false;
  const seen=new Set();for(const item of packet.cast)if(!item||typeof item.character_id!=='string'||seen.has(item.character_id)||!Number.isFinite(item.mouth)||!Number.isFinite(item.energy)||!Number.isFinite(item.gesture_at)||!(item.gesture==='idle'||Object.hasOwn(gestures,item.gesture))){return false;}else seen.add(item.character_id);
  const now=Date.now(),age=now-packet.updated_at;
  // A delayed unknown epoch must not retire the live epoch or poison sequence state.
  if(age>=MOTION_TTL||age < -5000||packet.updated_at<=state.resetAt||packet.updated_at<state.latestAt)return false;
  if(state.epoch!==packet.epoch){clearMotion(state);if(state.epoch){state.retired.add(state.epoch);if(state.retired.size>32)state.retired.delete(state.retired.values().next().value);}state.epoch=packet.epoch;state.seq=-1;}
  state.seq=packet.seq;state.latestAt=packet.updated_at;clearTimeout(state.timer);
  const cast=new Map(packet.cast.map(c=>[c.character_id,c]));
  for(const [id,a] of state.actors){const c=cast.get(id);if(!c||state.muted){idle(a);continue;}a.runtime={mouth:clamp(c.mouth,0,1),energy:clamp(c.energy,0,1),gesture:c.gesture,gesture_at:c.gesture_at};applyMouth(a);gesture(a,c.gesture,c.gesture_at,now);}
  state.timer=setTimeout(()=>{if(state.epoch===packet.epoch&&state.seq===packet.seq)clearMotion(state);},Math.max(0,Math.min(MOTION_TTL,MOTION_TTL-age)));
  return true;
}
root.StudioStage={portrait,publicScene,paint,setMotion,resetMotion};
})(globalThis);
