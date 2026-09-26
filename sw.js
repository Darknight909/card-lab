const CACHE='card-lab-shell-v1-8';
const ASSETS=['./index.html','./styles.css?v=1.8','./app.js?v=1.8','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-180.png','./version.json'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>Promise.allSettled(ASSETS.map(a=>c.add(new Request(a,{cache:'reload'}))))))});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('card-lab-')&&k!==CACHE)await caches.delete(k);await self.clients.claim()})())});
self.addEventListener('message',e=>{if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);if(u.origin!==self.location.origin)return;
  const core=e.request.mode==='navigate'||/\/(index\.html|app\.js|styles\.css|version\.json)$/.test(u.pathname);
  if(core){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request.mode==='navigate'?new Request('./index.html'):e.request,copy))}return r}).catch(async()=>{return (await caches.match(e.request))||(await caches.match('./index.html'))||Response.error()}));return}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(net=>{if(net.ok){const copy=net.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}return net})));
});
