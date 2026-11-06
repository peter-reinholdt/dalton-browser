/* Dalton isolation service worker v1. No application asset cache.
 * Provides COOP/COEP on static hosting; scope is the deployed application directory. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!url.href.startsWith(self.registration.scope))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.status===0)return response;
    const headers=new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy','same-origin');
    headers.set('Cross-Origin-Embedder-Policy','require-corp');
    headers.set('Cross-Origin-Resource-Policy','same-origin');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }));
});
