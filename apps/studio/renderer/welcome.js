'use strict';
const api=window.studioDesktop,status=document.getElementById('welcomeStatus');
async function action(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){status.textContent=e.message;}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
document.getElementById('importExisting').onclick=()=>action(()=>api.importWorkspace());
document.getElementById('startFresh').onclick=()=>action(()=>api.startFresh());
document.getElementById('recoverWorkspace').onclick=()=>action(()=>api.recover());
document.getElementById('showData').onclick=()=>api.showDataDirectory();
api.load().then(v=>{status.textContent=v.data?'已有资料，请重新打开工作室。':'创建空白工作室，或主动选择自己的备份。';}).catch(e=>{status.textContent=e.message;document.getElementById('startFresh').disabled=true;});
