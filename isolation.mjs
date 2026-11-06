// Initialize before editors become interactive. Never reload an active workspace.
export async function ensureIsolation() {
  if(globalThis.crossOriginIsolated)return true;
  if(!globalThis.isSecureContext||!navigator.serviceWorker)return false;
  const key='dalton-isolation-attempt-v1';
  try {
    if(sessionStorage.getItem(key))return false;
    sessionStorage.setItem(key,'1');
    await navigator.serviceWorker.register(new URL('./isolation-sw.js',import.meta.url),{scope:'./',updateViaCache:'none'});
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Isolation setup timed out')),8000))]);
    if(!navigator.serviceWorker.controller)await new Promise(resolve=>{
      const changed=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',changed);resolve();};
      const timer=setTimeout(changed,3000);navigator.serviceWorker.addEventListener('controllerchange',changed);
    });
    if(navigator.serviceWorker.controller){location.reload();await new Promise(()=>{});}
  }catch{ /* Serial engine remains available if registration/storage is blocked. */ }
  return false;
}
