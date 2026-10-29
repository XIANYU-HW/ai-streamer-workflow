'use strict';
function allowedNavigation(value,origin,paths=['/','/index.html','/welcome.html','/overlay.html','/scene-output.html']){
 try{const u=new URL(value);return u.origin===origin&&!u.username&&!u.password&&!u.search&&paths.includes(u.pathname);}catch{return false;}
}
function trustedIPC(event,wc,origin){return !!wc&&!wc.isDestroyed?.()&&event.sender===wc&&event.senderFrame===wc.mainFrame&&allowedNavigation(event.senderFrame.url,origin,['/','/index.html','/welcome.html']);}
module.exports={trustedIPC,allowedNavigation};
