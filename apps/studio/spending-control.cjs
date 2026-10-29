'use strict';
const busy=()=>Object.assign(new Error('请在运行场次与租约释放、云语音请求结束后设置费用模式。'),{code:'BUSY'});
// Called only by the control capability. This changes billing configuration,
// never grants output, starts a session, reads credentials or clears a ledger.
function createSpendingControl({vault,runtime,cloud}){
 let updating=false;
 return {
  assertNotUpdating(){if(updating)throw busy();},
  status:()=>vault.spendingStatus(),
  async configure(input){
   if(updating)throw busy();const state=runtime.status();
   if(state.closed||state.session||state.lease||state.active||state.utterance||state.queue_depth||cloud.active)throw busy();
   updating=true;
   try{await vault.configureSpending(input);return await vault.spendingStatus();}
   finally{updating=false;}
  }
 };
}
module.exports={createSpendingControl};
