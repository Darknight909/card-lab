'use strict';

const APP_VERSION = '2.0';
const $ = id => document.getElementById(id);
const DB = 'cardLabDB', STORE = 'cards', DRAFT = 'drafts';

let db;
let frontData = null, backData = null;
let lastEstimate = null, deferredPrompt = null;
let backendAnalysis = null, analysisMeta = null, analysisSnapshot = null;
let ebayData = null, marketData = null, currentCardId = null;
let analysisInFlight = false;
let autoIdentityReady = false, autoCenteringReady = false, autoConditionReady = false;
let centeringMeta = { front: null, back: null };
let ocrRaw = { front: '', back: '' }, ocrSuggestions = {};

function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function roundHalf(n){return Math.round(n*2)/2}
function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
function pctPair(a,b){const total=a+b;if(!total)return [50,50];const p=a/total*100;return [p,100-p]}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,2);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});s.createIndex('subject','subject')}if(!d.objectStoreNames.contains(DRAFT))d.createObjectStore(DRAFT,{keyPath:'key'})};r.onsuccess=()=>{db=r.result;res(db)};r.onerror=()=>rej(r.error)})}
function tx(mode='readonly'){return db.transaction(STORE,mode).objectStore(STORE)}
function dbAdd(v){return new Promise((res,rej)=>{const r=tx('readwrite').add(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbPut(v){return new Promise((res,rej)=>{const r=tx('readwrite').put(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbAll(){return new Promise((res,rej)=>{const r=tx().getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbDelete(id){return new Promise((res,rej)=>{const r=tx('readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function dbClear(){return new Promise((res,rej)=>{const r=tx('readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function draftStore(mode='readonly'){return db.transaction(DRAFT,mode).objectStore(DRAFT)}
function draftGet(){return new Promise((res,rej)=>{const r=draftStore().get('current');r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})}
function draftPut(v){return new Promise((res,rej)=>{const r=draftStore('readwrite').put({key:'current',...v});r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function draftClear(){return new Promise((res,rej)=>{const r=draftStore('readwrite').delete('current');r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

async function persistDraft(){
  try{
    await draftPut({frontData,backData,analysisSnapshot,currentCardId,centeringMeta,centeringValues:{front:centeringSide('front'),back:centeringSide('back')},updatedAt:new Date().toISOString()});
  }catch(e){console.warn('Could not save draft',e)}
}

async function restoreDraft(){
  try{
    const d=await draftGet(); if(!d)return;
    if(d.frontData?.dataUrl){frontData=d.frontData;showStoredPhoto('front',frontData)}
    if(d.backData?.dataUrl){backData=d.backData;showStoredPhoto('back',backData)}
    currentCardId=d.currentCardId!=null&&Number.isFinite(Number(d.currentCardId))?Number(d.currentCardId):null;
    centeringMeta=d.centeringMeta||{front:null,back:null};
    if(d.centeringValues){
      for(const side of ['front','back']){
        const v=d.centeringValues[side],pre=side==='front'?'front':'back';
        if(v){$(pre+'BorderL').value=v.L??5;$(pre+'BorderR').value=v.R??5;$(pre+'BorderT').value=v.T??5;$(pre+'BorderB').value=v.B??5}
      }
    }
    if(frontData&&!centeringMeta.front?.manual)await measureCentering('front',true);
    if(backData&&!centeringMeta.back?.manual)await measureCentering('back',true);
    updateCentering();
    if(d.analysisSnapshot?.version && String(d.analysisSnapshot.version).startsWith('2.')){
      analysisSnapshot=d.analysisSnapshot;
      await applyBackendAnalysis(d.analysisSnapshot,{skipSave:true,restoring:true});
      setIdentifyStatus('Previous Card Lab 2.0 analysis restored locally · tap Re-analyze card to refresh online results.');
    }else if(frontData||backData){
      setIdentifyStatus('Draft photos restored locally · tap Re-analyze card when both photos are ready.');
    }
    if(frontData||backData)toast('Draft restored');
  }catch(e){console.warn('Could not restore draft',e)}
}

function showStoredPhoto(side,data){
  const pre=side==='front'?'front':'back';
  $(pre+'Preview').src=data.dataUrl;$(pre+'Preview').style.display='block';
  $(pre+'Quality').innerHTML=qualityText(data.quality||{score:0,glare:0,sharp:0});
  const status=$(pre+'SavedStatus');if(status)status.textContent='Photo saved locally';
}

async function compressImage(file,max=2200,q=.88){
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bitmap.width*scale));c.height=Math.max(1,Math.round(bitmap.height*scale));
  c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);
  if(bitmap.close)bitmap.close();
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
  if(!blob)throw new Error('Image conversion failed');
  const dataUrl=await blobToDataUrl(blob);
  return {dataUrl,w:c.width,h:c.height,quality:analyzeQuality(c),bounds:null};
}
function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob)})}
function analyzeQuality(c){
  const W=Math.min(500,c.width),H=Math.max(1,Math.round(c.height*W/c.width));const s=document.createElement('canvas');s.width=W;s.height=H;const x=s.getContext('2d',{willReadFrequently:true});x.drawImage(c,0,0,W,H);const d=x.getImageData(0,0,W,H).data;
  let lum=0,clip=0,grad=0,count=0;const gray=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++){const y=.299*d[i]+.587*d[i+1]+.114*d[i+2];gray[j]=y;lum+=y;if(y>248)clip++}
  for(let y=1;y<H-1;y+=2)for(let xx=1;xx<W-1;xx+=2){const i=y*W+xx;grad+=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+W]-gray[i-W]);count++}
  const avg=lum/(W*H),glare=clip/(W*H),sharp=count?grad/count:0;let score=100;
  if(avg<55||avg>220)score-=25;if(glare>.05)score-=25;else if(glare>.02)score-=10;if(sharp<12)score-=25;else if(sharp<20)score-=10;if(c.width<900)score-=15;
  return {score:clamp(Math.round(score),0,100),brightness:Math.round(avg),glare:+(glare*100).toFixed(1),sharp:+sharp.toFixed(1)};
}
function qualityText(q){const cls=q.score>=80?'good':q.score>=60?'warn':'bad';return `<span class="${cls}">Photo quality ${q.score}/100</span> · glare ${q.glare}% · sharpness ${q.sharp}`}

async function handlePhoto(input,preview,quality,side){
  const f=input.files?.[0];if(!f)return;
  try{
    setIdentifyStatus(`<span class="spinner"></span>Preparing ${side} photo…`);
    const o=await compressImage(f);$(preview).src=o.dataUrl;$(preview).style.display='block';$(quality).innerHTML=qualityText(o.quality);
    if(side==='front'){frontData=o;if($('frontSavedStatus'))$('frontSavedStatus').textContent='Photo saved locally'}else{backData=o;if($('backSavedStatus'))$('backSavedStatus').textContent='Photo saved locally'}
    analysisSnapshot=null;backendAnalysis=null;analysisMeta=null;ebayData=null;marketData=null;currentCardId=null;lastEstimate=null;autoIdentityReady=false;autoConditionReady=false;
    centeringMeta[side]=null;
    $('identifyResults').classList.add('hidden');
    await measureCentering(side,true);
    await persistDraft();
    renderConditionSummary();renderEstimate();
    toast(`${side} photo ready · saved locally`);
    if(frontData&&backData&&!analysisInFlight)setTimeout(()=>identifyFromPhotos(),350);else setIdentifyStatus('Photo saved locally · add the other side to start automatic analysis.');
  }catch(e){console.error(e);setIdentifyStatus(`Photo processing failed: ${esc(e.message||String(e))}`);toast('Could not process photo')}
  finally{input.value=''}
}

function setIdentifyStatus(html){$('identifyStatus').innerHTML=html}

function backendConfig(){return {url:(localStorage.getItem('cardlab.backendUrl')||'').replace(/\/+$/,''),key:localStorage.getItem('cardlab.backendKey')||''}}
function loadBackendSettings(){const c=backendConfig();if($('backendUrl'))$('backendUrl').value=c.url;if($('backendKey'))$('backendKey').value=c.key;if($('backendStatus'))$('backendStatus').textContent=c.url?'Saved locally':'Not configured'}
function saveBackendSettings(){const url=($('backendUrl').value||'').trim().replace(/\/+$/,'');const key=($('backendKey').value||'').trim();if(url&&!/^https:\/\/.+/i.test(url)){toast('Worker URL must start with https://');return}localStorage.setItem('cardlab.backendUrl',url);localStorage.setItem('cardlab.backendKey',key);$('backendStatus').textContent=url&&key?'Saved locally':'Incomplete';toast('Backend settings saved')}
async function testBackend(){
  const {url,key}=backendConfig();if(!url){toast('Enter the Worker URL first');return}
  try{
    $('backendStatus').innerHTML='<span class="spinner"></span>Testing…';
    const h=await fetch(`${url}/health`,{cache:'no-store'});if(!h.ok)throw new Error(`HTTP ${h.status}`);const j=await h.json();
    if(!j.googleVisionConfigured)throw new Error('Google Vision secret is not configured');
    if(!j.workersAIConfigured)throw new Error('Cloudflare AI binding is not configured');
    if(key){const r=await fetch(`${url}/analyze`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({}),cache:'no-store'});if(r.status===401)throw new Error('API key rejected')}
    $('backendStatus').textContent=`Connected · API v${j.version||'?'} · Google Vision ready${j.tavilyConfigured?' · web verification ready':' · Tavily not configured'}${j.ebayConfigured?' · eBay API connected':''}`;
    toast('Card Lab backend connected');
  }catch(e){$('backendStatus').textContent=`Connection failed: ${e.message||e}`;toast('Backend connection failed')}
}

function nearestOption(selectId,value){const el=$(selectId);if(!el||value==null)return;const vals=[...el.options].map(o=>+o.value).filter(Number.isFinite);if(!vals.length)return;let best=vals[0];for(const v of vals)if(Math.abs(v-value)<Math.abs(best-value))best=v;el.value=String(best)}

function renderBackendSummary(a,ebay){
  const i=a.identity||{},c=a.condition||{};const identConf=Math.round(a.identity_confidence||0),condConf=Math.round(a.condition_confidence||0);
  const gv=analysisMeta?.googleVision||{}, wl=analysisMeta?.webLookup||{};
  const fullMatches=(gv.front?.fullMatchCount||0)+(gv.back?.fullMatchCount||0),partialMatches=(gv.front?.partialMatchCount||0)+(gv.back?.partialMatchCount||0),pages=(gv.front?.matchingPages?.length||0)+(gv.back?.matchingPages?.length||0);
  const badges=[`Google OCR`,fullMatches?`${fullMatches} full visual match${fullMatches===1?'':'es'}`:null,pages?`${pages} matching page${pages===1?'':'s'}`:null,partialMatches?`${partialMatches} partial visual match${partialMatches===1?'':'es'}`:null,wl.used?'independent web verification':null,'local centering'].filter(Boolean).map(x=>`<span class="pipeline-badge">${esc(x)}</span>`).join('');
  const review=a.needs_review?`<div class="warn"><strong>Review recommended:</strong> ${esc(a.review_reason||'The automatic identification is not fully certain.')}</div>`:'<div class="good"><strong>Automatic identification passed confidence check.</strong></div>';
  const evidence=(a.evidence||[]).length?`<details><summary>Identification evidence</summary><ul class="hint">${a.evidence.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:'';
  const notes=(c.notes||[]).length?`<details><summary>Visible-condition notes</summary><ul class="hint">${c.notes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:'';
  const webCount=(marketData?.items||[]).length;const ebayMsg=webCount?` · ${webCount} current listing matches loaded`:(ebay?.configured?(ebay.items?.length?` · ${ebay.items.length} current eBay matches loaded`:' · eBay connected, no close matches'):' · web listing search enabled');
  $('identifyResults').classList.remove('hidden');
  $('identifyResults').innerHTML=`<div class="suggestion">${esc([i.year,i.set||i.brand,i.subject,i.cardNo?`#${i.cardNo}`:''].filter(Boolean).join(' · ')||'Card analyzed')}</div><div>${badges}</div><div class="hint stage-list">Identity confidence ${identConf}% · visible-condition confidence ${condConf}%${ebayMsg}</div>${review}${evidence}${notes}`;
}
function renderMarket(market,ebay){
  marketData=market||null;const root=$('marketResults');if(!root)return;const items=(market?.items||ebay?.items||[]).slice(0,6);const searchUrl=market?.searchUrl||ebay?.searchUrl||'';
  if(!items.length){root.classList.remove('empty');root.innerHTML=`<div class="hint">No embedded current listings found.${searchUrl?` <a href="${esc(searchUrl)}" target="_blank" rel="noopener">Open live eBay search</a>`:''}</div>`;return}
  root.classList.remove('empty');root.innerHTML=`<div class="market-list">${items.map(x=>`<a class="market-item" href="${esc(x.url||searchUrl)}" target="_blank" rel="noopener"><strong>${esc(x.title||'eBay listing')}</strong>${x.price!=null&&Number.isFinite(Number(x.price))?`<span>$${Number(x.price).toFixed(2)}</span>`:''}</a>`).join('')}</div>${searchUrl?`<div class="hint"><a href="${esc(searchUrl)}" target="_blank" rel="noopener">See full eBay search</a></div>`:''}`;
}
function backendConditionReady(){const c=backendAnalysis?.condition||{};return [c.corners,c.edges,c.surface,c.focus].every(v=>Number.isFinite(Number(v))&&Number(v)>=1&&Number(v)<=10)&&Number(backendAnalysis?.condition_confidence||0)>=45}
function renderConditionSummary(){
  const c=backendAnalysis?.condition||{},d=c.defects||{};const flags=Object.entries(d).filter(([,v])=>v).map(([k])=>k.replaceAll('_',' '));const el=$('conditionAutoSummary');if(!el)return;
  if(!autoConditionReady){el.innerHTML='<span class="warn">Waiting for reliable automatic condition analysis. No grade will be calculated until this completes.</span>';return}
  if(!backendConditionReady()&&$('confirmed').checked){el.innerHTML='<span class="warn">Using your manual physical-card condition correction. Automatic condition evidence was insufficient.</span>';return}
  el.innerHTML=`Corners ${esc(c.corners??'-')} · Edges ${esc(c.edges??'-')} · Surface ${esc(c.surface??'-')} · Focus ${esc(c.focus??'-')}${flags.length?`<br><span class="warn">Visible flags: ${esc(flags.join(', '))}</span>`:'<br><span class="good">No major visible defect flags detected in these photos.</span>'}`;
}

async function applyBackendAnalysis(result,{skipSave=false,restoring=false}={}){
  backendAnalysis=result.analysis||null;analysisMeta={version:result.version,googleVision:result.googleVision||null,webLookup:result.webLookup||null,pipeline:result.pipeline||null};ebayData=result.ebay||null;marketData=result.market||null;
  const a=backendAnalysis||{},i=a.identity||{},c=a.condition||{},d=c.defects||{};
  const identConf=Number(a.identity_confidence||0);
  autoIdentityReady=Boolean(i.year&&(i.set||i.brand)&&i.subject&&i.cardNo&&identConf>=70);
  autoConditionReady=backendConditionReady();
  const fields={year:i.year??'Unknown',set:i.set||i.brand||'Unknown',subject:i.subject||'Unknown',cardNo:i.cardNo||'Unknown',variation:i.variation||'Base / not identified'};for(const [id,val] of Object.entries(fields))$(id).value=String(val);
  if(i.category&&[...$('category').options].some(o=>o.value===i.category))$('category').value=i.category;
  if(autoConditionReady){nearestOption('corners',c.corners);nearestOption('edges',c.edges);nearestOption('surface',c.surface);nearestOption('focusScore',c.focus)}
  $('crease').checked=!!d.crease;$('dent').checked=!!d.dent;$('stain').checked=!!d.stain;$('scratch').checked=!!d.scratch;$('printline').checked=!!d.printline;$('mark').checked=!!d.mark;$('altered').checked=!!d.possible_alteration;$('confirmed').checked=false;
  await ensureLocalCentering();updateCentering();renderConditionSummary();renderEstimate();renderBackendSummary(a,result.ebay);renderMarket(result.market,result.ebay);
  if(!restoring)analysisSnapshot=result;
  if(autoIdentityReady&&!skipSave){await saveCardAutomatic();if(backendAnalysis?.needs_review&&$('saveStatus'))$('saveStatus').textContent+=' · identity flagged for review'}
  else if(autoIdentityReady&&restoring){if($('saveStatus'))$('saveStatus').textContent=currentCardId?`Previously saved locally · card #${currentCardId}`:'Analysis restored locally'}
  else if($('saveStatus'))$('saveStatus').textContent='Not saved yet: automatic identification is incomplete or below the confidence threshold.';
  await persistDraft();
}

async function loadImage(dataUrl){const img=new Image();img.src=dataUrl;await img.decode();return img}
function median(values){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function smoothProfile(a,r=2){const out=new Float32Array(a.length);for(let i=0;i<a.length;i++){let s=0,n=0;for(let k=Math.max(0,i-r);k<=Math.min(a.length-1,i+r);k++){s+=a[k];n++}out[i]=s/n}return out}

async function detectCardBounds(dataUrl){
  const img=await loadImage(dataUrl);const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;const maxDim=560,scale=Math.min(1,maxDim/Math.max(iw,ih));const W=Math.max(80,Math.round(iw*scale)),H=Math.max(80,Math.round(ih*scale));
  const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);const d=ctx.getImageData(0,0,W,H).data;
  const patch=Math.max(4,Math.round(Math.min(W,H)*.055));const samples=[];
  const addPatch=(x0,y0)=>{for(let y=y0;y<Math.min(H,y0+patch);y+=2)for(let x=x0;x<Math.min(W,x0+patch);x+=2){const i=(y*W+x)*4;samples.push([d[i],d[i+1],d[i+2]])}};
  addPatch(0,0);addPatch(W-patch,0);addPatch(0,H-patch);addPatch(W-patch,H-patch);
  const bg=[0,1,2].map(k=>samples.reduce((s,p)=>s+p[k],0)/Math.max(1,samples.length));
  let variance=0;for(const p of samples)variance+=(p[0]-bg[0])**2+(p[1]-bg[1])**2+(p[2]-bg[2])**2;const bgStd=Math.sqrt(variance/Math.max(1,samples.length*3));const threshold=clamp(30+bgStd*1.8,30,82);
  const cols=new Uint32Array(W),rows=new Uint32Array(H);let fg=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;const dist=Math.sqrt((d[i]-bg[0])**2+(d[i+1]-bg[1])**2+(d[i+2]-bg[2])**2);if(dist>threshold){cols[x]++;rows[y]++;fg++}}
  const xs=[],ys=[];for(let x=0;x<W;x++)if(cols[x]/H>.18)xs.push(x);for(let y=0;y<H;y++)if(rows[y]/W>.18)ys.push(y);
  if(xs.length<10||ys.length<10)return {x:0,y:0,w:iw,h:ih,reliable:false,confidence:20,reason:'card edge not isolated from background'};
  let x1=xs[0],x2=xs[xs.length-1],y1=ys[0],y2=ys[ys.length-1];
  const pad=Math.max(1,Math.round(Math.min(W,H)*.006));x1=Math.max(0,x1-pad);y1=Math.max(0,y1-pad);x2=Math.min(W-1,x2+pad);y2=Math.min(H-1,y2+pad);
  const bw=x2-x1+1,bh=y2-y1+1,fill=(bw*bh)/(W*H),shortLong=Math.min(bw,bh)/Math.max(bw,bh),touch=x1<2||y1<2||x2>W-3||y2>H-3;
  const aspectScore=clamp(1-Math.abs(shortLong-.714)/.20,0,1),fillScore=fill>.32&&fill<.97?1:fill>.22&&fill<.99?.55:0,bgScore=clamp(1-bgStd/45,.2,1),edgeScore=touch?.35:1;
  const confidence=Math.round(100*(.38*aspectScore+.27*fillScore+.20*bgScore+.15*edgeScore));const reliable=confidence>=58&&shortLong>.54&&shortLong<.90&&fill>.20;
  const sx=iw/W,sy=ih/H;return {x:Math.round(x1*sx),y:Math.round(y1*sy),w:Math.round(bw*sx),h:Math.round(bh*sy),reliable,confidence,reason:reliable?'card rectangle isolated':'low-confidence card rectangle'};
}

async function cropForAnalysis(dataUrl,bounds,max=2200,q=.90){
  const img=await loadImage(dataUrl);const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;const b=bounds?.reliable?bounds:{x:0,y:0,w:iw,h:ih};const scale=Math.min(1,max/Math.max(b.w,b.h));const W=Math.max(1,Math.round(b.w*scale)),H=Math.max(1,Math.round(b.h*scale));const c=document.createElement('canvas');c.width=W;c.height=H;c.getContext('2d').drawImage(img,b.x,b.y,b.w,b.h,0,0,W,H);return c.toDataURL('image/jpeg',q)
}

function bestPeak(profile,start,end,preferOuter=false){
  const a=Math.max(2,Math.floor(start)),b=Math.min(profile.length-3,Math.ceil(end));const vals=[];for(let i=a;i<=b;i++)vals.push(profile[i]);const med=median(vals)||.001;let best={idx:a,value:-Infinity,score:-Infinity,prominence:0};
  for(let i=a;i<=b;i++){const prom=profile[i]/med;const pos=(i-a)/Math.max(1,b-a);const outerBias=preferOuter?(1-.20*pos):1;const score=prom*outerBias;if(score>best.score)best={idx:i,value:profile[i],score,prominence:prom}}
  return best;
}

async function measureCentering(side,silent=false){
  const data=side==='front'?frontData:backData;if(!data){if(!silent)toast(`Take the ${side} photo first`);return null}
  try{
    let bounds=data.bounds;if(!bounds){bounds=await detectCardBounds(data.dataUrl);data.bounds=bounds}
    const cropped=await cropForAnalysis(data.dataUrl,bounds,720,.90);const img=await loadImage(cropped);const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;const scale=Math.min(1,620/Math.max(iw,ih));const W=Math.max(120,Math.round(iw*scale)),H=Math.max(120,Math.round(ih*scale));const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);const px=ctx.getImageData(0,0,W,H).data;
    const v=new Float32Array(W),h=new Float32Array(H);
    for(let x=2;x<W-2;x++){let sum=0,n=0;for(let y=Math.round(H*.12);y<H*.88;y+=2){const i=(y*W+x)*4,j=(y*W+x-2)*4,k=(y*W+x+2)*4;sum+=Math.abs(px[k]-px[j])+Math.abs(px[k+1]-px[j+1])+Math.abs(px[k+2]-px[j+2]);n++}v[x]=n?sum/n:0}
    for(let y=2;y<H-2;y++){let sum=0,n=0;for(let x=Math.round(W*.12);x<W*.88;x+=2){const j=((y-2)*W+x)*4,k=((y+2)*W+x)*4;sum+=Math.abs(px[k]-px[j])+Math.abs(px[k+1]-px[j+1])+Math.abs(px[k+2]-px[j+2]);n++}h[y]=n?sum/n:0}
    const vs=smoothProfile(v,2),hs=smoothProfile(h,2);const L=bestPeak(vs,W*.025,W*.29,true),R=bestPeak(vs,W*.71,W*.975,false),T=bestPeak(hs,H*.025,H*.29,true),B=bestPeak(hs,H*.71,H*.975,false);
    const widths={L:L.idx/W*100,R:(W-1-R.idx)/W*100,T:T.idx/H*100,B:(H-1-B.idx)/H*100};
    const axisConfidence=(p1,p2,a,b)=>{const prom=Math.min(p1.prominence,p2.prominence);const strength=clamp((prom-1.10)/2.5,0,1);const balance=clamp(Math.min(p1.value,p2.value)/Math.max(1,Math.max(p1.value,p2.value)),0,1);const plausible=(a>1&&b>1&&a<30&&b<30)?1:.25;return Math.round(100*(.60*strength+.25*balance+.15*plausible))};
    const lrConf=axisConfidence(L,R,widths.L,widths.R),tbConf=axisConfidence(T,B,widths.T,widths.B),confidence=Math.round(.45*lrConf+.45*tbConf+.10*(bounds.confidence||20));
    const reliable=bounds.reliable&&lrConf>=52&&tbConf>=52&&confidence>=58;
    const pre=side==='front'?'front':'back';
    if(reliable){$(pre+'BorderL').value=widths.L.toFixed(2);$(pre+'BorderR').value=widths.R.toFixed(2);$(pre+'BorderT').value=widths.T.toFixed(2);$(pre+'BorderB').value=widths.B.toFixed(2)}
    centeringMeta[side]={reliable,confidence,manual:false,boundsConfidence:bounds.confidence,lrConfidence:lrConf,tbConfidence:tbConf,reason:reliable?'design-border peaks detected':'design borders were not consistent enough to trust'};
    autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);updateCentering();if(!silent)toast(reliable?`${side} centering measured · confidence ${confidence}%`:`${side} centering withheld · low confidence`);return centeringMeta[side];
  }catch(e){console.warn('Centering measurement failed',e);centeringMeta[side]={reliable:false,confidence:0,manual:false,reason:'measurement failed'};autoCenteringReady=false;updateCentering();if(!silent)toast(`${side} centering could not be measured`);return centeringMeta[side]}
}
async function ensureLocalCentering(){if(frontData&&!centeringMeta.front?.manual)await measureCentering('front',true);if(backData&&!centeringMeta.back?.manual)await measureCentering('back',true);autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable)}
function markCenteringManual(side){centeringMeta[side]={reliable:true,confidence:100,manual:true,reason:'manual correction'};autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);updateCentering();renderEstimate();persistDraft()}
function centeringSide(side){const pre=side==='front'?'front':'back';const L=+$(pre+'BorderL').value||0,R=+$(pre+'BorderR').value||0,T=+$(pre+'BorderT').value||0,B=+$(pre+'BorderB').value||0;const lr=pctPair(L,R),tb=pctPair(T,B);return {L,R,T,B,lr,tb,worst:Math.max(...lr,...tb)}}
function centering(){return {front:centeringSide('front'),back:centeringSide('back')}}
function updateCentering(){
  autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);
  for(const side of ['front','back']){const m=centeringMeta[side],el=$(side+'CenteringReadout');if(!m?.reliable){el.innerHTML=`<span class="warn">Unable to measure reliably${m?.confidence?` · confidence ${m.confidence}%`:''}</span>`;continue}const c=centeringSide(side);el.textContent=`L/R ${c.lr[0].toFixed(1)}/${c.lr[1].toFixed(1)} · T/B ${c.tb[0].toFixed(1)}/${c.tb[1].toFixed(1)} · ${m.manual?'manual':'confidence '+m.confidence+'%'}`}
}

async function prepareAnalysisImage(side){const data=side==='front'?frontData:backData;if(!data)return null;if(!data.bounds)data.bounds=await detectCardBounds(data.dataUrl);return cropForAnalysis(data.dataUrl,data.bounds,1800,.88)}
async function analyzeRequest(url,key,payload){
  let lastErr=null;for(let attempt=1;attempt<=3;attempt++){
    try{if(attempt>1)setIdentifyStatus(`<span class="spinner"></span>Connection interrupted · retrying automatically (${attempt}/3)…`);const r=await fetch(`${url}/analyze`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify(payload),cache:'no-store'});const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{}if(!r.ok||!j.ok){const err=new Error(j.error||`HTTP ${r.status}`);if(r.status>=500&&attempt<3){lastErr=err;await sleep(900*attempt);continue}throw err}return j}catch(e){lastErr=e;const networkish=e instanceof TypeError||/load failed|network|fetch/i.test(String(e?.message||e));if(attempt<3&&networkish){await sleep(900*attempt);continue}throw e}}
  throw lastErr||new Error('Analysis request failed');
}
async function identifyFromPhotos(){
  if(!frontData||!backData){toast('Take both front and back photos first');return}const {url,key}=backendConfig();if(!url||!key){toast('Set up the Cloudflare backend in Settings first');document.querySelector('[data-tab="settings"]').click();return}
  try{
    analysisInFlight=true;$('identifyBtn').disabled=true;setIdentifyStatus('<span class="spinner"></span>Measuring centering locally…');await ensureLocalCentering();
    setIdentifyStatus('<span class="spinner"></span>Preparing high-detail card crops…');const [frontForAnalysis,backForAnalysis]=await Promise.all([prepareAnalysisImage('front'),prepareAnalysisImage('back')]);
    setIdentifyStatus('<span class="spinner"></span>Google visual match + OCR → web verification → condition analysis…');const j=await analyzeRequest(url,key,{front:frontForAnalysis,back:backForAnalysis});
    await applyBackendAnalysis(j);setIdentifyStatus('Automatic analysis complete · identity verified online, centering measured locally, and visible condition inspected.');toast(autoIdentityReady?'Card identified and pre-graded':'Analysis complete · identity needs review');
  }catch(e){console.error(e);setIdentifyStatus(`Analysis failed: ${esc(e.message||String(e))}`);toast('Automatic analysis failed')}
  finally{analysisInFlight=false;$('identifyBtn').disabled=false}
}

function baseScores(){return {corners:+$('corners').value,edges:+$('edges').value,surface:+$('surface').value,focus:+$('focusScore').value}}
function defectCaps(){let cap=10,flags=[];if($('altered').checked){cap=0;flags.push('Possible alteration/restoration: professional graders may return No Grade/Authentic rather than a numeric grade.')}if($('crease').checked){cap=Math.min(cap,5);flags.push('Crease/wrinkle strongly caps high grades.')}if($('dent').checked){cap=Math.min(cap,7);flags.push('Dent/indentation caps high grades even if difficult to photograph.')}if($('stain').checked){cap=Math.min(cap,7);flags.push('Staining/discoloration limits upper grades.')}if($('scratch').checked){cap=Math.min(cap,8);flags.push('Noticeable surface scratch limits upper grades.')}if($('printline').checked){cap=Math.min(cap,9);flags.push('Print/refractor line affects surface grade.')}if($('mark').checked){cap=Math.min(cap,6);flags.push('Writing/marks may receive a qualifier or substantially lower grade.')}return {cap,flags}}
function gradeCapFromThreshold(worst,rows){for(const [limit,grade] of rows)if(worst<=limit)return grade;return rows[rows.length-1][1]}
function centerCaps(c){
  const fw=c.front.worst,bw=c.back.worst;const psaFront=gradeCapFromThreshold(fw,[[55,10],[60,9],[65,8],[70,7],[80,6],[85,5],[90,3],[100,1]]),psaBack=gradeCapFromThreshold(bw,[[75,10],[90,9],[100,1]]),psa=Math.min(psaFront,psaBack);
  const fAxes=[c.front.lr,c.front.tb].map(a=>Math.max(...a)).sort((a,b)=>a-b);let bgsFront;if(fAxes[1]<=50.5)bgsFront=10;else if(fAxes[0]<=50.5&&fAxes[1]<=55)bgsFront=9.5;else bgsFront=gradeCapFromThreshold(fw,[[55,9],[60,8],[65,7],[70,6],[75,5],[80,4],[85,3],[90,2],[100,1]]);const bgsBack=gradeCapFromThreshold(bw,[[55,10],[60,9.5],[70,9],[80,8],[90,7],[95,6],[100,4]]),bgs=Math.min(bgsFront,bgsBack);
  const cgcFront=gradeCapFromThreshold(fw,[[50.5,10],[55,10],[60,9],[65,8],[70,7],[75,6],[80,5],[85,4],[90,3],[100,1]]),cgcBack=gradeCapFromThreshold(bw,[[75,10],[90,9],[95,7],[100,5]]),cgc=Math.min(cgcFront,cgcBack);
  const sgcFront=gradeCapFromThreshold(fw,[[50.5,10],[55,10],[60,9.5],[65,9],[70,8],[75,7],[80,6],[85,5],[90,3],[100,1]]),sgcBack=gradeCapFromThreshold(bw,[[75,10],[90,9],[95,7],[100,5]]);return {psa,bgs,cgc,sgc:Math.min(sgcFront,sgcBack)};
}
function companyGrades(){
  const s=baseScores(),c=centering(),cc=centerCaps(c),dc=defectCaps(),core=Math.min(s.corners,s.edges,s.surface,s.focus,dc.cap||10),avg=(s.corners+s.edges+s.surface+s.focus)/4;let psa=Math.min(cc.psa,dc.cap||10,Math.floor(Math.min(10,(core*.72+avg*.28)+.35)));if(dc.cap===0)psa=0;
  const bgsSurface=Math.min(s.surface,s.focus),bgsSubs=[Math.min(cc.bgs,10),s.corners,s.edges,bgsSurface],low=Math.min(...bgsSubs,dc.cap||10),bavg=bgsSubs.reduce((a,b)=>a+b,0)/4;let bgs=roundHalf(Math.min(cc.bgs,dc.cap||10,low+Math.min(1,Math.max(0,(bavg-low)*.45))));if(bgs===10&&!bgsSubs.every(x=>x>=10))bgs=9.5;if(dc.cap===0)bgs=0;
  const cgcCore=Math.min(s.corners,s.edges,s.surface,s.focus);let cgc=roundHalf(Math.min(cc.cgc,dc.cap||10,cgcCore+.25));if(cgc>9.5&&c.front.worst>55)cgc=9.5;if(dc.cap===0)cgc=0;const sgcCore=Math.min(s.corners,s.edges,s.surface,s.focus);let sgc=roundHalf(Math.min(cc.sgc,dc.cap||10,sgcCore+.25));if(dc.cap===0)sgc=0;
  const q=[frontData?.quality?.score||0,backData?.quality?.score||0].filter(Boolean),qavg=q.length?q.reduce((a,b)=>a+b,0)/q.length:0,aiConf=Number(backendAnalysis?.condition_confidence||0),centerConf=(Number(centeringMeta.front?.confidence||0)+Number(centeringMeta.back?.confidence||0))/2;let confidence=Math.round(qavg*.32+aiConf*.38+centerConf*.30);confidence=clamp(confidence,10,95);
  return {psa,bgs,cgc,sgc,bgsSubs:{centering:bgsSubs[0],corners:s.corners,edges:s.edges,surface:bgsSurface},centering:c,flags:dc.flags,confidence};
}
function fmtGrade(g,company){if(g===0)return 'NG?';if(company==='SGC'&&g===10)return '10';return String(g)}
function renderEstimate(){
  if(!autoConditionReady||!autoCenteringReady){lastEstimate=null;$('gradeResults').classList.remove('empty');const missing=[!autoConditionReady?'reliable visible-condition data':null,!autoCenteringReady?'reliable front/back centering':null].filter(Boolean).join(' and ');$('gradeResults').innerHTML=`<div class="warn"><strong>Automatic grade not available yet.</strong> Card Lab is missing ${esc(missing)} and will not invent a grade.</div>`;return}
  lastEstimate=companyGrades();const e=lastEstimate,q=e.confidence>=80?'good':e.confidence>=60?'warn':'bad';$('gradeResults').classList.remove('empty');$('gradeResults').innerHTML=`<div class="grade-grid"><div class="grade-box"><small>PSA estimate</small><b>${fmtGrade(e.psa,'PSA')}</b><small>whole-number scale</small></div><div class="grade-box"><small>BGS estimate</small><b>${fmtGrade(e.bgs,'BGS')}</b><small>C ${e.bgsSubs.centering} · Co ${e.bgsSubs.corners} · E ${e.bgsSubs.edges} · S ${e.bgsSubs.surface}</small></div><div class="grade-box"><small>CGC estimate</small><b>${fmtGrade(e.cgc,'CGC')}</b><small>published-scale approximation</small></div><div class="grade-box"><small>SGC estimate</small><b>${fmtGrade(e.sgc,'SGC')}</b><small>published-scale approximation</small></div></div><div class="confidence ${q}">Confidence ${e.confidence}% · Front ${e.centering.front.lr[0].toFixed(1)}/${e.centering.front.lr[1].toFixed(1)} L/R, ${e.centering.front.tb[0].toFixed(1)}/${e.centering.front.tb[1].toFixed(1)} T/B · Back ${e.centering.back.lr[0].toFixed(1)}/${e.centering.back.lr[1].toFixed(1)} L/R, ${e.centering.back.tb[0].toFixed(1)}/${e.centering.back.tb[1].toFixed(1)} T/B.</div><div class="hint">Pre-grade estimate only. Microscopic defects, alterations, texture/indentations and in-hand eye appeal may change a professional grade.</div>${e.flags.length?'<ul class="hint">'+e.flags.map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>':''}`;
}

function cardQuery(){return [$('year').value,$('set').value,$('subject').value,$('cardNo').value,$('variation').value].filter(Boolean).join(' ').trim()}
function ebaySearch(){const q=cardQuery(),u=marketData?.searchUrl||ebayData?.searchUrl||(q?`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`:'');if(!u){toast('Card identity is not ready yet');return}window.open(u,'_blank','noopener')}
function currentRecord(){if(!lastEstimate&&autoConditionReady&&autoCenteringReady)lastEstimate=companyGrades();return {createdAt:new Date().toISOString(),year:$('year').value,set:$('set').value,subject:$('subject').value,cardNo:$('cardNo').value,variation:$('variation').value,category:$('category').value,cost:+$('cost').value||0,notes:$('notes').value,front:frontData?.dataUrl||null,back:backData?.dataUrl||null,frontQuality:frontData?.quality||null,backQuality:backData?.quality||null,identification:{backend:backendAnalysis,meta:analysisMeta,ebay:ebayData,market:marketData,suggestions:ocrSuggestions,frontText:ocrRaw.front,backText:ocrRaw.back},centering:centering(),centeringMeta,scores:baseScores(),defects:{crease:$('crease').checked,dent:$('dent').checked,stain:$('stain').checked,scratch:$('scratch').checked,printline:$('printline').checked,mark:$('mark').checked,altered:$('altered').checked,confirmed:$('confirmed').checked},estimate:lastEstimate}}
async function saveCardAutomatic(){const rec=currentRecord();if(!autoIdentityReady||['Unknown',''].includes(rec.subject)||['Unknown',''].includes(rec.cardNo)||['Unknown',''].includes(rec.set))return;if(currentCardId){rec.id=currentCardId;await dbPut(rec)}else currentCardId=await dbAdd(rec);if($('saveStatus'))$('saveStatus').textContent=`Saved automatically to collection · local card #${currentCardId}`;await renderCollection();await persistDraft()}

async function resetForm(){
  document.querySelectorAll('#grade input[type=text],#grade input[type=number]').forEach(x=>x.value='');['frontBorderL','frontBorderR','frontBorderT','frontBorderB','backBorderL','backBorderR','backBorderT','backBorderB'].forEach(id=>$(id).value=5);document.querySelectorAll('#grade input[type=checkbox]').forEach(x=>x.checked=false);$('corners').value=$('edges').value=$('surface').value='9';$('focusScore').value='9';$('category').value='Sports';$('frontPreview').style.display=$('backPreview').style.display='none';['frontCameraInput','frontLibraryInput','backCameraInput','backLibraryInput'].forEach(id=>{if($(id))$(id).value=''});if($('frontSavedStatus'))$('frontSavedStatus').textContent='No photo saved yet';if($('backSavedStatus'))$('backSavedStatus').textContent='No photo saved yet';$('frontQuality').innerHTML=$('backQuality').innerHTML='';
  frontData=backData=lastEstimate=null;analysisSnapshot=backendAnalysis=analysisMeta=ebayData=marketData=null;currentCardId=null;centeringMeta={front:null,back:null};autoIdentityReady=autoCenteringReady=autoConditionReady=false;await draftClear();$('identifyResults').classList.add('hidden');setIdentifyStatus('Google visual matching + OCR identify the card; Cloudflare analyzes visible condition. Photos are processed transiently and your collection stays on this phone.');$('gradeResults').className='results empty';$('gradeResults').textContent='Add front and back photos. Grade estimates will appear automatically.';if($('marketResults')){$('marketResults').className='results empty';$('marketResults').textContent='Current listing matches will appear automatically after identification.'}if($('conditionAutoSummary'))$('conditionAutoSummary').textContent='Waiting for analysis.';if($('saveStatus'))$('saveStatus').textContent='The analyzed card will be saved to your local collection automatically.';updateCentering();window.scrollTo({top:0,behavior:'smooth'});
}

async function renderCollection(){const all=await dbAll(),term=($('collectionSearch').value||'').toLowerCase(),rows=all.filter(c=>JSON.stringify([c.year,c.set,c.subject,c.cardNo,c.variation]).toLowerCase().includes(term)).sort((a,b)=>b.id-a.id);$('collectionStats').textContent=`${all.length} card${all.length===1?'':'s'} stored locally`;const root=$('collectionList');if(!rows.length){root.innerHTML='<div class="card-block hint">No matching cards.</div>';return}root.innerHTML=rows.map(c=>`<div class="collection-card"><img src="${c.front||''}" alt=""><div><div class="collection-title">${esc([c.year,c.subject].filter(Boolean).join(' ')||'Untitled card')}</div><div class="collection-sub">${esc([c.set,c.cardNo,c.variation].filter(Boolean).join(' · '))}</div><span class="pill">PSA ${fmtGrade(c.estimate?.psa??'-','PSA')}</span><span class="pill">BGS ${fmtGrade(c.estimate?.bgs??'-','BGS')}</span><span class="pill">CGC ${fmtGrade(c.estimate?.cgc??'-','CGC')}</span><span class="pill">SGC ${fmtGrade(c.estimate?.sgc??'-','SGC')}</span></div><div class="collection-actions"><button class="secondary" data-ebay="${c.id}">eBay</button><button class="danger" data-del="${c.id}">Delete</button></div></div>`).join('');root.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this card from the local collection?')){await dbDelete(+b.dataset.del);renderCollection()}});root.querySelectorAll('[data-ebay]').forEach(b=>b.onclick=()=>{const c=rows.find(x=>x.id===+b.dataset.ebay),q=[c.year,c.set,c.subject,c.cardNo,c.variation].filter(Boolean).join(' ');window.open(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,'_blank','noopener')})}
function downloadJson(obj,name){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
async function exportBackup(){const data=await dbAll();downloadJson({version:3,type:'collection',exportedAt:new Date().toISOString(),cards:data},`card-lab-collection-${new Date().toISOString().slice(0,10)}.json`)}
async function exportRecovery(){if(!confirm('Full recovery contains your private Cloudflare API key and draft card photos. Export and store it securely?'))return;const data=await dbAll(),draft=await draftGet();downloadJson({version:3,type:'full-recovery',exportedAt:new Date().toISOString(),cards:data,draft,settings:{backendUrl:localStorage.getItem('cardlab.backendUrl')||'',backendKey:localStorage.getItem('cardlab.backendKey')||''}},`card-lab-full-recovery-${new Date().toISOString().slice(0,10)}.json`);toast('Full recovery exported')}
async function importBackup(file){try{const j=JSON.parse(await file.text());if(!Array.isArray(j.cards))throw 0;for(const c of j.cards){delete c.id;await dbAdd(c)}if(j.settings){localStorage.setItem('cardlab.backendUrl',j.settings.backendUrl||'');localStorage.setItem('cardlab.backendKey',j.settings.backendKey||'');loadBackendSettings()}if(j.draft){const {key,...draft}=j.draft;await draftPut({...draft,updatedAt:draft.updatedAt||new Date().toISOString()});await restoreDraft()}toast(`Imported ${j.cards.length} cards${j.settings?' + settings':''}`);renderCollection()}catch(e){console.warn(e);toast('Invalid backup file')}}

let updateReloading=false,lastUpdateCheck=0;
async function registerUpdater(){if(!('serviceWorker' in navigator))return;try{const reg=await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`,{updateViaCache:'none'});navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updateReloading)return;updateReloading=true;location.reload()});const activateWaiting=()=>{if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'})};reg.addEventListener('updatefound',()=>{const w=reg.installing;if(!w)return;w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)w.postMessage({type:'SKIP_WAITING'})})});await reg.update();activateWaiting()}catch(e){console.warn('Updater registration failed',e)}}
async function checkForUpdate(manual=false){const now=Date.now();if(!manual&&now-lastUpdateCheck<120000)return;lastUpdateCheck=now;const status=$('updateStatus');if(manual&&status)status.textContent='Checking…';try{const r=await fetch(`./version.json?t=${now}`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j.version&&j.version!==APP_VERSION){if(status)status.textContent=`Update v${j.version} found · installing`;toast(`Card Lab v${j.version} update found`);await registerUpdater();setTimeout(()=>location.reload(),900)}else{if(status)status.textContent=`v${APP_VERSION} is current`;if(manual)toast(`Card Lab v${APP_VERSION} is current`)}}catch(e){if(status)status.textContent='Update check unavailable';if(manual)toast('Could not check for update')}}
async function requestPersistentStorage(){try{if(navigator.storage?.persist)await navigator.storage.persist()}catch{}}

function bind(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));b.classList.add('active');$(b.dataset.tab).classList.add('active');if(b.dataset.tab==='collection')renderCollection()});
  $('frontCameraBtn').onclick=()=>$('frontCameraInput').click();$('frontLibraryBtn').onclick=()=>$('frontLibraryInput').click();$('backCameraBtn').onclick=()=>$('backCameraInput').click();$('backLibraryBtn').onclick=()=>$('backLibraryInput').click();
  ['frontCameraInput','frontLibraryInput'].forEach(id=>{$(id).onchange=()=>handlePhoto($(id),'frontPreview','frontQuality','front')});['backCameraInput','backLibraryInput'].forEach(id=>{$(id).onchange=()=>handlePhoto($(id),'backPreview','backQuality','back')});
  $('autoFrontCenterBtn').onclick=()=>measureCentering('front');$('autoBackCenterBtn').onclick=()=>measureCentering('back');
  for(const side of ['front','back'])for(const suffix of ['BorderL','BorderR','BorderT','BorderB'])$(side+suffix).oninput=()=>markCenteringManual(side);
  ['corners','edges','surface','focusScore','crease','dent','stain','scratch','printline','mark','altered','confirmed'].forEach(id=>$(id).onchange=()=>{autoConditionReady=backendConditionReady()||$('confirmed').checked;renderConditionSummary();renderEstimate()});
  $('identifyBtn').onclick=identifyFromPhotos;$('ebayBtn').onclick=ebaySearch;$('saveBackendBtn').onclick=saveBackendSettings;$('testBackendBtn').onclick=testBackend;$('resetBtn').onclick=resetForm;$('collectionSearch').oninput=renderCollection;$('exportBtn').onclick=exportBackup;if($('exportRecoveryBtn'))$('exportRecoveryBtn').onclick=exportRecovery;if($('checkUpdateBtn'))$('checkUpdateBtn').onclick=()=>checkForUpdate(true);$('importInput').onchange=()=>{const f=$('importInput').files?.[0];if(f)importBackup(f)};$('clearBtn').onclick=async()=>{if(confirm('Erase the entire local card collection? This cannot be undone unless you exported a backup.')){await dbClear();renderCollection();toast('Collection erased')}};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('installBtn').classList.add('hidden')}else toast('Use your browser Add to Home Screen option')};
}

(async function init(){await openDB();bind();loadBackendSettings();updateCentering();await restoreDraft();await requestPersistentStorage();await registerUpdater();setTimeout(()=>checkForUpdate(false),1000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkForUpdate(false)});window.addEventListener('pageshow',()=>checkForUpdate(false))})();
