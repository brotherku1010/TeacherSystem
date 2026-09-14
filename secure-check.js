// Support diagnostic: no real UID, LINE token, order or financial operation.
(() => {
 const button=document.getElementById('check'),output=document.getElementById('result');
 const gasUrl=document.querySelector('meta[name="gas-url"]').content;
 button.addEventListener('click',async()=>{
  button.disabled=true;output.textContent='正在檢查安全連線，約需 20–60 秒…';
  try {
   const health=await SecureGAS.request(gasUrl,'health',{});
   if(health.securityVersion!==2||!health.ownerEmailScopeReady)throw new Error('版本或 Google 授權尚未備妥');
   output.textContent='① 新版 GAS 與 Google 授權：通過\n正在檢查 UID 冒用防護…';
   let rejected=false;
   try{await SecureGAS.request(gasUrl,'login',{userId:'U11111111111111111111111111111111'});}catch(error){if(/逾時/.test(error.message))throw error;rejected=true;}
   if(!rejected)throw new Error('UID 冒用防護未通過');
   output.textContent+='\n② 僅帶 UID 登入：已拒絕\n正在檢查偽造憑證…';rejected=false;
   try{await SecureGAS.request(gasUrl,'session',{sessionToken:'0'.repeat(64)});}catch(error){if(/逾時/.test(error.message))throw error;rejected=true;}
   if(!rejected)throw new Error('偽造憑證防護未通過');
   output.textContent='① 新版 GAS 與 Google 授權：通過\n② 僅帶 UID 登入：已拒絕\n③ 偽造登入憑證：已拒絕\n安全連線檢查完成。實際 LINE 登入仍需本人操作。';
  } catch(error){output.textContent='檢查未完成：'+error.message;}
  finally{button.disabled=false;}
 });
})();
