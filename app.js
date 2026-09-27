'use strict';

const APP_VERSION = '3.0';
const $ = id => document.getElementById(id);
const DB = 'cardLabDB', STORE = 'cards', DRAFT = 'drafts';

let db;
let frontData = null, backData = null;
let lastEstimate = null, deferredPrompt = null;
let backendAnalysis = null, analysisMeta = null, analysisSnapshot = null;
let ebayData = null, marketData = null, currentCardId = null;
let identityLocked = false, currentHistory = [], marketFilter = 'raw';
let currentOpenedAt = null;
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

function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,3);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});s.createIndex('subject','subject')}if(!d.objectStoreNames.contains(DRAFT))d.createObjectStore(DRAFT,{keyPath:'key'})};r.onsuccess=()=>{db=r.result;res(db)};r.onerror=()=>rej(r.error)})}
function tx(mode='readonly'){return db.transaction(STORE,mode).objectStore(STORE)}
function dbAdd(v){return new Promise((res,rej)=>{const r=tx('readwrite').add(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbPut(v){return new Promise((res,rej)=>{const r=tx('readwrite').put(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbAll(){return new Promise((res,rej)=>{const r=tx().getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbGet(id){return new Promise((res,rej)=>{const r=tx().get(id);r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})}
function dbDelete(id){return new Promise((res,rej)=>{const r=tx('readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function dbClear(){return new Promise((res,rej)=>{const r=tx('readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function draftStore(mode='readonly'){return db.transaction(DRAFT,mode).objectStore(DRAFT)}
function draftGet(){return new Promise((res,rej)=>{const r=draftStore().get('current');r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})}
function draftPut(v){return new Promise((res,rej)=>{const r=draftStore('readwrite').put({key:'current',...v});r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function draftClear(){return new Promise((res,rej)=>{const r=draftStore('readwrite').delete('current');r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}



function savedIdentityTrusted(card){
  const status=card?.identification?.backend?.verification_status;
  const ver=String(card?.identification?.meta?.version||card?.analysisSnapshot?.version||'');
  return ver.startsWith('3.')&&['verified','locked'].includes(status);
}

async function persistDraft(){
  try{
    await draftPut({
      frontData,backData,analysisSnapshot,currentCardId,identityLocked,centeringMeta,
      centeringValues:{front:centeringSide('front'),back:centeringSide('back')},
      updatedAt:new Date().toISOString()
    });
  }catch(e){console.warn('Could not save draft',e)}
}

async function restoreDraft(){
  try{
    const d=await draftGet(); if(!d)return;
    if(d.frontData?.dataUrl){frontData=d.frontData;showStoredPhoto('front',frontData)}
    if(d.backData?.dataUrl){backData=d.backData;showStoredPhoto('back',backData)}
    currentCardId=d.currentCardId!=null&&Number.isFinite(Number(d.currentCardId))?Number(d.currentCardId):null;
    identityLocked=false;
    if(currentCardId){
      const saved=await dbGet(currentCardId);
      currentHistory=Array.isArray(saved?.history)?saved.history:[];
      currentOpenedAt=saved?.updatedAt||saved?.createdAt||null;
      if(saved){
        setFormFromSaved(saved);
        marketData=saved.market||saved.identification?.market||null;
        ebayData=saved.identification?.ebay||null;
        backendAnalysis=saved.identification?.backend||null;
        identityLocked=savedIdentityTrusted(saved);
      }
    }
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
    if(d.analysisSnapshot?.version && String(d.analysisSnapshot.version).startsWith('3.')){
      analysisSnapshot=d.analysisSnapshot;
      await applyBackendAnalysis(d.analysisSnapshot,{skipSave:true,restoring:true});
      setIdentifyStatus(identityLocked?'Saved card restored · identity locked · Re-analyze refreshes grade and eBay without re-identifying.':'Previous Card Lab 3.0 analysis restored locally · tap Re-analyze card to refresh.');
    }else if(frontData||backData){
      setIdentifyStatus('Draft photos restored locally · tap Re-analyze card when both photos are ready.');
    }
    renderHistory();
    if(frontData||backData)toast('Draft restored');
  }catch(e){console.warn('Could not restore draft',e)}
}

function showStoredPhoto(side,data){
  const pre=side==='front'?'front':'back';
  $(pre+'Preview').src=data.dataUrl;$(pre+'Preview').style.display='block';
  $(pre+'Quality').innerHTML=qualityText(data.quality||{score:0,glare:0,sharp:0});
  const status=$(pre+'SavedStatus');if(status)status.textContent='Photo saved locally';
}


function imageFingerprint(c){
  const w=9,h=8,s=document.createElement('canvas');s.width=w;s.height=h;const x=s.getContext('2d',{willReadFrequently:true});x.drawImage(c,0,0,w,h);const d=x.getImageData(0,0,w,h).data;const g=[];
  for(let i=0;i<d.length;i+=4)g.push(.299*d[i]+.587*d[i+1]+.114*d[i+2]);
  let bits='',hex='';
  for(let y=0;y<h;y++)for(let xx=0;xx<8;xx++)bits+=g[y*w+xx]>g[y*w+xx+1]?'1':'0';
  for(let i=0;i<bits.length;i+=4)hex+=parseInt(bits.slice(i,i+4),2).toString(16);
  return hex;
}
function hammingHex(a,b){
  if(!a||!b||a.length!==b.length)return 999;let n=0;
  for(let i=0;i<a.length;i++){let v=parseInt(a[i],16)^parseInt(b[i],16);while(v){n+=v&1;v>>=1}}
  return n;
}

async function compressImage(file,max=2200,q=.88){
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bitmap.width*scale));c.height=Math.max(1,Math.round(bitmap.height*scale));
  c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);
  if(bitmap.close)bitmap.close();
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
  if(!blob)throw new Error('Image conversion failed');
  const [dataUrl,contentHash]=await Promise.all([blobToDataUrl(blob),blobHash(blob)]);
  return {dataUrl,w:c.width,h:c.height,quality:analyzeQuality(c),bounds:null,fingerprint:imageFingerprint(c),contentHash};
}
function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob)})}
async function blobHash(blob){
  try{
    const buf=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }catch{return null}
}
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


function photoGate(){
  const problems=[];
  for(const [side,d] of [['front',frontData],['back',backData]]){
    if(!d)continue;
    const q=d.quality||{};
    if(Number(q.score)<45)problems.push(`${side} photo quality is too low`);
    if(Number(q.glare)>18)problems.push(`${side} has heavy glare`);
    if(Number(q.sharp)<7)problems.push(`${side} is too soft/blurred`);
    if(d.bounds && !d.bounds.reliable && Number(d.bounds.confidence||0)<35)problems.push(`${side} card edge is not isolated from the background`);
  }
  return {pass:problems.length===0,problems};
}

async function handlePhoto(input,preview,quality,side){
  const f=input.files?.[0];if(!f)return;
  try{
    setIdentifyStatus(`<span class="spinner"></span>Preparing ${side} photo…`);
    const o=await compressImage(f);
    try{o.bounds=await detectCardBounds(o.dataUrl)}catch{}
    $(preview).src=o.dataUrl;$(preview).style.display='block';$(quality).innerHTML=qualityText(o.quality);
    if(side==='front'){frontData=o;if($('frontSavedStatus'))$('frontSavedStatus').textContent='Photo saved locally'}else{backData=o;if($('backSavedStatus'))$('backSavedStatus').textContent='Photo saved locally'}
    if(currentCardId&&identityLocked){
      analysisSnapshot=null;lastEstimate=null;autoConditionReady=false;
      // Keep the already verified identity/sources while a saved card gets new photos.
      marketData=null;ebayData=null;
    }else{
      analysisSnapshot=null;backendAnalysis=null;analysisMeta=null;ebayData=null;marketData=null;lastEstimate=null;autoConditionReady=false;
      autoIdentityReady=false;identityLocked=false;currentHistory=[];
    }
    centeringMeta[side]=null;
    $('identifyResults').classList.add('hidden');
    await measureCentering(side,true);
    await persistDraft();
    renderConditionSummary();renderEstimate();renderHistory();
    toast(`${side} photo ready · saved locally`);
    if(frontData&&backData&&!analysisInFlight){
      const gate=photoGate();
      if(gate.pass)setTimeout(()=>identifyFromPhotos(false),350);
      else setIdentifyStatus(`<span class="warn">Photo-quality check stopped automatic analysis: ${esc(gate.problems.join('; '))}. Retake the affected photo.</span>`);
    }else setIdentifyStatus('Photo saved locally · add the other side to start automatic analysis.');
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
    $('backendStatus').textContent=`Connected · API v${j.version||'?'} · Google Vision ready${j.tavilyConfigured?' · trusted-source web verification ready':' · Tavily not configured'}${j.ebayConfigured?' · eBay API connected':' · eBay API not connected (fallback only)'}`;
    toast('Card Lab backend connected');
  }catch(e){$('backendStatus').textContent=`Connection failed: ${e.message||e}`;toast('Backend connection failed')}
}

function nearestOption(selectId,value){const el=$(selectId);if(!el||value==null)return;const vals=[...el.options].map(o=>+o.value).filter(Number.isFinite);if(!vals.length)return;let best=vals[0];for(const v of vals)if(Math.abs(v-value)<Math.abs(best-value))best=v;el.value=String(best)}


function safeHttpUrl(u){
  try{const x=new URL(String(u||''));return /^https?:$/.test(x.protocol)?x.href:''}catch{return ''}
}
function formatMoney(v,currency='USD'){
  const n=Number(v);if(!Number.isFinite(n))return '';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(n)}catch{return `$${n.toFixed(2)}`}
}
function formatDateTime(v){
  if(!v)return '';try{return new Date(v).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}catch{return String(v)}
}

function renderBackendSummary(a,ebay){
  const i=a.identity||{},c=a.condition||{};const identConf=Math.round(a.identity_confidence||0),condConf=Math.round(a.condition_confidence||0);
  const status=a.verification_status||'unverified';
  const statusText=status==='verified'?'Verified online':status==='locked'?'Verified identity locked':status==='probable'?'Probable — review':'Not verified';
  const statusClass=['verified','locked'].includes(status)?'good':'warn';
  const marketCount=(marketData?.items||[]).length;
  const marketMsg=marketData?.live?` · ${marketCount} live eBay match${marketCount===1?'':'es'}`:marketCount?` · ${marketCount} web-indexed eBay match${marketCount===1?'':'es'}`:'';
  const serial=a.serial_number?` · serial ${a.serial_number}`:'';
  const sources=(a.sources||[]).filter(x=>safeHttpUrl(x.url));
  const sourceHtml=sources.length?`<details open><summary>Verified identity sources</summary><ul class="source-list">${sources.map(x=>`<li><a href="${esc(safeHttpUrl(x.url))}" target="_blank" rel="noopener">${esc(x.title||x.domain||'Source')}</a><span> · ${esc(x.domain||'')}</span></li>`).join('')}</ul></details>`:'';
  const evidence=(a.evidence||[]).length?`<details><summary>Why Card Lab accepted this identity</summary><ul class="hint">${a.evidence.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:'';
  const notes=(c.notes||[]).length?`<details><summary>Visible-condition notes</summary><ul class="hint">${c.notes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:'';
  $('identifyResults').classList.remove('hidden');
  $('identifyResults').innerHTML=`<div class="suggestion">${esc([i.year,i.set||i.brand,i.subject,i.cardNo?`#${i.cardNo}`:'',i.variation].filter(Boolean).join(' · ')||'Card analyzed')}</div>
    <div class="${statusClass}"><strong>${esc(statusText)}</strong> · identity confidence ${identConf}%${serial}</div>
    <div class="hint stage-list">Visible-condition confidence ${condConf}%${marketMsg}</div>
    ${a.needs_review?`<div class="warn"><strong>Review:</strong> ${esc(a.review_reason||'Identity needs additional corroboration.')}</div>`:''}
    ${sourceHtml}${evidence}${notes}`;
}

function marketItemsForFilter(){
  if(!marketData)return [];
  if(marketFilter==='graded')return marketData.gradedItems||[];
  if(marketFilter==='all')return marketData.items||[];
  return marketData.rawItems||marketData.items||[];
}
function renderMarket(market=marketData,ebay=ebayData){
  marketData=market||marketData||null;const root=$('marketResults');if(!root)return;
  const searchUrl=safeHttpUrl(marketData?.searchUrl||ebay?.searchUrl||'');
  const items=marketItemsForFilter().slice(0,12);
  const live=Boolean(marketData?.live);
  const source=marketData?.source||'';
  const stats=marketFilter==='graded'?marketData?.stats?.graded:marketFilter==='all'?null:marketData?.stats?.raw;
  const status=`<div class="market-status ${live?'good':'warn'}"><strong>${live?'Live eBay Browse API':'Fallback market results'}</strong>${source?` · ${esc(source)}`:''}${marketData?.refreshedAt?` · refreshed ${esc(formatDateTime(marketData.refreshedAt))}`:''}</div>`;
  const tabs=$('marketTabs');if(tabs)tabs.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.marketFilter===marketFilter));
  const statsHtml=stats?`<div class="market-stats"><span>Matches <b>${stats.sampleSize}</b></span><span>Low <b>${formatMoney(stats.low)}</b></span><span>Median <b>${formatMoney(stats.median)}</b></span><span>High <b>${formatMoney(stats.high)}</b></span></div>`:'';
  if(!items.length){
    root.classList.remove('empty');
    root.innerHTML=`${status}${statsHtml}<div class="hint">No sufficiently close ${esc(marketFilter)} listing matches found.${searchUrl?` <a href="${esc(searchUrl)}" target="_blank" rel="noopener">Open full eBay search</a>`:''}</div>${marketData?.note?`<div class="hint">${esc(marketData.note)}</div>`:''}`;
    return;
  }
  const cards=items.map(x=>{
    const u=safeHttpUrl(x.url||searchUrl),price=formatMoney(x.price,x.currency),ship=Number.isFinite(Number(x.shipping))?formatMoney(x.shipping,x.currency):'';
    const seller=x.seller?.username?`Seller ${esc(x.seller.username)}${Number.isFinite(Number(x.seller.feedbackPercentage))?` · ${Number(x.seller.feedbackPercentage).toFixed(1)}%`:''}`:'';
    const kind=x.kind==='graded'?`${x.gradingCompany||'Graded'}${x.grade?` ${x.grade}`:''}`:'Raw';
    const meta=[x.condition,kind,ship?`Shipping ${ship}`:null,seller].filter(Boolean).join(' · ');
    return `<a class="market-card" href="${esc(u||searchUrl)}" target="_blank" rel="noopener">
      ${x.image&&safeHttpUrl(x.image)?`<img src="${esc(safeHttpUrl(x.image))}" alt="">`:''}
      <div class="market-card-body"><strong>${esc(x.title||'eBay listing')}</strong><div class="hint">${esc(meta)}</div>${x.imageMatched?'<span class="pill">image + keyword match</span>':''}</div>
      <div class="market-price">${price||'View'}<small>Open listing</small></div>
    </a>`;
  }).join('');
  root.classList.remove('empty');root.innerHTML=`${status}${statsHtml}<div class="market-list">${cards}</div>${marketData?.note?`<div class="hint">${esc(marketData.note)}</div>`:''}${searchUrl?`<div class="hint"><a href="${esc(searchUrl)}" target="_blank" rel="noopener">Open full eBay search</a></div>`:''}`;
}

function backendConditionReady(){const c=backendAnalysis?.condition||{};return [c.corners,c.edges,c.surface,c.focus].every(v=>Number.isFinite(Number(v))&&Number(v)>=1&&Number(v)<=10)&&Number(backendAnalysis?.condition_confidence||0)>=45}
function renderConditionSummary(){
  const c=backendAnalysis?.condition||{},d=c.defects||{};const flags=Object.entries(d).filter(([,v])=>v).map(([k])=>k.replaceAll('_',' '));const el=$('conditionAutoSummary');if(!el)return;
  if(!autoConditionReady){el.innerHTML='<span class="warn">Waiting for reliable automatic condition analysis. No grade will be calculated until this completes.</span>';return}
  if(!backendConditionReady()&&$('confirmed').checked){el.innerHTML='<span class="warn">Using your manual physical-card condition correction. Automatic condition evidence was insufficient.</span>';return}
  el.innerHTML=`Corners ${esc(c.corners??'-')} · Edges ${esc(c.edges??'-')} · Surface ${esc(c.surface??'-')} · Focus ${esc(c.focus??'-')}${flags.length?`<br><span class="warn">Visible flags: ${esc(flags.join(', '))}</span>`:'<br><span class="good">No major visible defect flags detected in these photos.</span>'}`;
}

function visionCenteringFor(side){
  const c=backendAnalysis?.condition?.sides?.[side]?.centering;
  if(!c?.lr||!c?.tb||Number(c.confidence||0)<55)return null;
  return {lr:c.lr,tb:c.tb,confidence:Number(c.confidence||0)};
}
function pairWorst(pair){return Array.isArray(pair)?Math.max(...pair.map(Number)):null}
function reconcileCenteringWithVision(){
  for(const side of ['front','back']){
    const local=centeringMeta[side],vision=visionCenteringFor(side);
    if(!local?.reliable||local.manual||!vision)continue;
    const c=centeringSide(side);
    const dLR=Math.abs(pairWorst(c.lr)-pairWorst(vision.lr)),dTB=Math.abs(pairWorst(c.tb)-pairWorst(vision.tb));
    if(dLR>10||dTB>10){
      centeringMeta[side]={...local,reliable:false,visionConflict:true,confidence:Math.min(local.confidence||0,45),reason:'local border measurement disagreed with independent vision centering estimate'};
    }else if(dLR<=5&&dTB<=5){
      centeringMeta[side]={...local,visionConfirmed:true,confidence:Math.min(95,(local.confidence||0)+5),reason:'local border measurement independently cross-checked'};
    }
  }
  autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);
  updateCentering();
}

async function applyBackendAnalysis(result,{skipSave=false,restoring=false,reidentify=false}={}){
  backendAnalysis=result.analysis||null;
  analysisMeta={version:result.version,googleVision:result.googleVision||null,webLookup:result.webLookup||null,pipeline:result.pipeline||null};
  ebayData=result.ebay||null;marketData=result.market||null;
  const a=backendAnalysis||{},i=a.identity||{},c=a.condition||{},d=c.defects||{};
  const status=a.verification_status||'unverified';
  autoIdentityReady=Boolean(i.year&&i.set&&i.subject&&i.cardNo&&['verified','locked'].includes(status));
  if(reidentify)identityLocked=['verified','locked'].includes(status);
  else if(status==='verified'||status==='locked')identityLocked=true;
  autoConditionReady=backendConditionReady();
  const fields={year:i.year??'',set:i.set||i.brand||'',subject:i.subject||'',cardNo:i.cardNo||'',variation:i.variation||'',serialNo:a.serial_number||''};
  for(const [id,val] of Object.entries(fields))if($(id))$(id).value=String(val);
  if(i.category&&[...$('category').options].some(o=>o.value===i.category))$('category').value=i.category;
  if(autoConditionReady){nearestOption('corners',c.corners);nearestOption('edges',c.edges);nearestOption('surface',c.surface);nearestOption('focusScore',c.focus)}
  $('crease').checked=!!d.crease;$('dent').checked=!!d.dent;$('stain').checked=!!d.stain;$('scratch').checked=!!d.scratch;$('printline').checked=!!d.printline;$('mark').checked=!!d.mark;$('altered').checked=!!d.possible_alteration;$('confirmed').checked=false;
  await ensureLocalCentering();reconcileCenteringWithVision();renderConditionSummary();renderEstimate();renderBackendSummary(a,result.ebay);renderMarket(result.market,result.ebay);
  if(!restoring)analysisSnapshot=result;
  if(autoIdentityReady&&!skipSave){
    await saveCardAutomatic({appendHistory:true,reidentify});
  }else if(autoIdentityReady&&restoring){
    if($('saveStatus'))$('saveStatus').textContent=currentCardId?`Saved locally · card #${currentCardId} · identity locked`:'Analysis restored locally';
  }else if($('saveStatus')){
    $('saveStatus').textContent='Not saved automatically: exact identity has not passed the trusted-source verification gate.';
  }
  renderHistory();
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


function profileMedian(profile,a,b){
  const vals=[];for(let i=Math.max(1,Math.floor(a));i<=Math.min(profile.length-2,Math.ceil(b));i++)vals.push(profile[i]);
  return median(vals)||.001;
}
function localPeaks(profile,start,end,maxCount=8){
  const a=Math.max(3,Math.floor(start)),b=Math.min(profile.length-4,Math.ceil(end)),med=profileMedian(profile,a,b),out=[];
  for(let i=a;i<=b;i++){
    if(profile[i]>=profile[i-1]&&profile[i]>=profile[i+1]){
      const prom=profile[i]/med;
      if(prom>=1.08)out.push({idx:i,value:profile[i],prominence:prom});
    }
  }
  return out.sort((x,y)=>y.prominence-x.prominence).slice(0,maxCount);
}
function verticalContinuity(gray,W,H,x){
  let good=0,total=0;
  for(let y=Math.round(H*.08);y<H*.92;y+=4){
    let at=0,rowMax=0;
    for(let xx=Math.max(2,x-2);xx<=Math.min(W-3,x+2);xx++){
      const i=y*W+xx;at=Math.max(at,Math.abs(gray[i+1]-gray[i-1]));
    }
    const lim=Math.max(4,Math.round(W*.24));
    for(let xx=2;xx<lim;xx+=3){const i=y*W+xx;rowMax=Math.max(rowMax,Math.abs(gray[i+1]-gray[i-1]))}
    for(let xx=W-lim;xx<W-2;xx+=3){const i=y*W+xx;rowMax=Math.max(rowMax,Math.abs(gray[i+1]-gray[i-1]))}
    if(rowMax>0&&at>=rowMax*.48)good++;total++;
  }
  return total?good/total:0;
}
function horizontalContinuity(gray,W,H,y){
  let good=0,total=0;
  for(let x=Math.round(W*.08);x<W*.92;x+=4){
    let at=0,colMax=0;
    for(let yy=Math.max(2,y-2);yy<=Math.min(H-3,y+2);yy++){
      const i=yy*W+x;at=Math.max(at,Math.abs(gray[i+W]-gray[i-W]));
    }
    const lim=Math.max(4,Math.round(H*.24));
    for(let yy=2;yy<lim;yy+=3){const i=yy*W+x;colMax=Math.max(colMax,Math.abs(gray[i+W]-gray[i-W]))}
    for(let yy=H-lim;yy<H-2;yy+=3){const i=yy*W+x;colMax=Math.max(colMax,Math.abs(gray[i+W]-gray[i-W]))}
    if(colMax>0&&at>=colMax*.48)good++;total++;
  }
  return total?good/total:0;
}
function chooseBorderPair(profile,size,gray,W,H,axis){
  const left=localPeaks(profile,size*.018,size*.25,10),right=localPeaks(profile,size*.75,size*.982,10);
  let best=null;
  for(const L of left)for(const R of right){
    const m1=L.idx/size*100,m2=(size-1-R.idx)/size*100,span=(R.idx-L.idx)/size;
    if(m1<.8||m2<.8||m1>28||m2>28||span<.52)continue;
    const c1=axis==='x'?verticalContinuity(gray,W,H,L.idx):horizontalContinuity(gray,W,H,L.idx);
    const c2=axis==='x'?verticalContinuity(gray,W,H,R.idx):horizontalContinuity(gray,W,H,R.idx);
    const prom=Math.min(L.prominence,R.prominence);
    const continuity=Math.min(c1,c2);
    const outerBias=1-clamp(((m1+m2)/2-4)/30,0,.28);
    const score=(prom*1.35+continuity*3.3)*outerBias;
    if(!best||score>best.score)best={L,R,m1,m2,c1,c2,prominence:prom,continuity,score};
  }
  return best;
}

async function measureCentering(side,silent=false){
  const data=side==='front'?frontData:backData;if(!data){if(!silent)toast(`Take the ${side} photo first`);return null}
  try{
    let bounds=data.bounds;if(!bounds){bounds=await detectCardBounds(data.dataUrl);data.bounds=bounds}
    if(!bounds?.reliable){
      centeringMeta[side]={reliable:false,confidence:Math.min(45,bounds?.confidence||0),manual:false,reason:'physical card edge could not be isolated reliably'};
      autoCenteringReady=false;updateCentering();return centeringMeta[side];
    }
    const cropped=await cropForAnalysis(data.dataUrl,bounds,760,.92),img=await loadImage(cropped),iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
    const scale=Math.min(1,680/Math.max(iw,ih)),W=Math.max(160,Math.round(iw*scale)),H=Math.max(160,Math.round(ih*scale));
    const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);const px=ctx.getImageData(0,0,W,H).data,gray=new Float32Array(W*H);
    for(let i=0,j=0;i<px.length;i+=4,j++)gray[j]=.299*px[i]+.587*px[i+1]+.114*px[i+2];
    const v=new Float32Array(W),h=new Float32Array(H);
    for(let x=2;x<W-2;x++){let sum=0,n=0;for(let y=Math.round(H*.08);y<H*.92;y+=2){const i=y*W+x;sum+=Math.abs(gray[i+2]-gray[i-2]);n++}v[x]=n?sum/n:0}
    for(let y=2;y<H-2;y++){let sum=0,n=0;for(let x=Math.round(W*.08);x<W*.92;x+=2){const i=y*W+x;sum+=Math.abs(gray[i+2*W]-gray[i-2*W]);n++}h[y]=n?sum/n:0}
    const lr=chooseBorderPair(smoothProfile(v,2),W,gray,W,H,'x'),tb=chooseBorderPair(smoothProfile(h,2),H,gray,W,H,'y');
    if(!lr||!tb){
      centeringMeta[side]={reliable:false,confidence:35,manual:false,boundsConfidence:bounds.confidence,reason:'no continuous paired design borders found'};
      autoCenteringReady=false;updateCentering();return centeringMeta[side];
    }
    const widths={L:lr.m1,R:lr.m2,T:tb.m1,B:tb.m2};
    const axisConf=p=>{
      const prom=clamp((p.prominence-1.05)/2.4,0,1),cont=clamp((p.continuity-.20)/.65,0,1),margin=clamp(1-Math.max(0,((p.m1+p.m2)/2-18)/10),.2,1);
      return Math.round(100*(.42*prom+.48*cont+.10*margin));
    };
    const lrConf=axisConf(lr),tbConf=axisConf(tb),confidence=Math.round(.43*lrConf+.43*tbConf+.14*(bounds.confidence||0));
    const reliable=lrConf>=58&&tbConf>=58&&confidence>=60;
    const pre=side==='front'?'front':'back';
    if(reliable){$(pre+'BorderL').value=widths.L.toFixed(2);$(pre+'BorderR').value=widths.R.toFixed(2);$(pre+'BorderT').value=widths.T.toFixed(2);$(pre+'BorderB').value=widths.B.toFixed(2)}
    centeringMeta[side]={reliable,confidence,manual:false,boundsConfidence:bounds.confidence,lrConfidence:lrConf,tbConfidence:tbConf,continuityLR:+lr.continuity.toFixed(2),continuityTB:+tb.continuity.toFixed(2),reason:reliable?'continuous paired design borders detected':'design-border evidence was not consistent enough to trust'};
    autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);updateCentering();
    if(!silent)toast(reliable?`${side} centering measured · confidence ${confidence}%`:`${side} centering withheld · low confidence`);
    return centeringMeta[side];
  }catch(e){
    console.warn('Centering measurement failed',e);centeringMeta[side]={reliable:false,confidence:0,manual:false,reason:'measurement failed'};autoCenteringReady=false;updateCentering();if(!silent)toast(`${side} centering could not be measured`);return centeringMeta[side]
  }
}

async function ensureLocalCentering(){if(frontData&&!centeringMeta.front?.manual)await measureCentering('front',true);if(backData&&!centeringMeta.back?.manual)await measureCentering('back',true);autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable)}
function markCenteringManual(side){centeringMeta[side]={reliable:true,confidence:100,manual:true,reason:'manual correction'};autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);updateCentering();renderEstimate();persistDraft()}
function centeringSide(side){const pre=side==='front'?'front':'back';const L=+$(pre+'BorderL').value||0,R=+$(pre+'BorderR').value||0,T=+$(pre+'BorderT').value||0,B=+$(pre+'BorderB').value||0;const lr=pctPair(L,R),tb=pctPair(T,B);return {L,R,T,B,lr,tb,worst:Math.max(...lr,...tb)}}
function centering(){return {front:centeringSide('front'),back:centeringSide('back')}}
function updateCentering(){
  autoCenteringReady=Boolean(centeringMeta.front?.reliable&&centeringMeta.back?.reliable);
  for(const side of ['front','back']){const m=centeringMeta[side],el=$(side+'CenteringReadout');if(!m?.reliable){el.innerHTML=`<span class="warn">Unable to measure reliably${m?.confidence?` · confidence ${m.confidence}%`:''}</span>`;continue}const c=centeringSide(side);el.textContent=`L/R ${c.lr[0].toFixed(1)}/${c.lr[1].toFixed(1)} · T/B ${c.tb[0].toFixed(1)}/${c.tb[1].toFixed(1)} · ${m.manual?'manual':'confidence '+m.confidence+'%'}`}
}


async function prepareAnalysisImage(side){
  const data=side==='front'?frontData:backData;if(!data)return null;
  if(!data.bounds)data.bounds=await detectCardBounds(data.dataUrl);
  return cropForAnalysis(data.dataUrl,data.bounds,1600,.90);
}
async function analyzeRequest(url,key,payload){
  let lastErr=null;for(let attempt=1;attempt<=3;attempt++){
    try{
      if(attempt>1)setIdentifyStatus(`<span class="spinner"></span>Connection interrupted · retrying automatically (${attempt}/3)…`);
      const r=await fetch(`${url}/analyze`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify(payload),cache:'no-store'});
      const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{}
      if(!r.ok||!j.ok){const err=new Error(j.error||`HTTP ${r.status}`);if(r.status>=500&&attempt<3){lastErr=err;await sleep(900*attempt);continue}throw err}
      return j
    }catch(e){lastErr=e;const networkish=e instanceof TypeError||/load failed|network|fetch/i.test(String(e?.message||e));if(attempt<3&&networkish){await sleep(900*attempt);continue}throw e}
  }
  throw lastErr||new Error('Analysis request failed');
}
function lockedIdentityPayload(){
  if(!identityLocked||!currentCardId)return null;
  const i=backendAnalysis?.identity||{};
  const year=Number(i.year),set=String(i.set||'').trim(),subject=String(i.subject||'').trim(),cardNo=String(i.cardNo||'').trim();
  if(!Number.isFinite(year)||!set||!subject||!cardNo)return null;
  return {year,set,subject,cardNo,variation:i.variation||null,category:i.category||$('category').value,brand:i.brand||null,team:i.team||null};
}
async function identifyFromPhotos(reidentify=false){
  if(!frontData||!backData){toast('Take both front and back photos first');return}
  const gate=photoGate();if(!gate.pass){setIdentifyStatus(`<span class="warn">Analysis stopped by photo-quality check: ${esc(gate.problems.join('; '))}.</span>`);toast('Retake the affected photo');return}
  const {url,key}=backendConfig();if(!url||!key){toast('Set up the Cloudflare backend in Settings first');document.querySelector('[data-tab="settings"]').click();return}
  try{
    analysisInFlight=true;$('identifyBtn').disabled=true;if($('reidentifyBtn'))$('reidentifyBtn').disabled=true;
    setIdentifyStatus('<span class="spinner"></span>Measuring centering locally…');await ensureLocalCentering();
    setIdentifyStatus('<span class="spinner"></span>Preparing analysis copies…');
    const [frontForAnalysis,backForAnalysis]=await Promise.all([prepareAnalysisImage('front'),prepareAnalysisImage('back')]);
    const lock=!reidentify?lockedIdentityPayload():null;
    setIdentifyStatus(lock?'<span class="spinner"></span>Identity locked · refreshing condition, grades, and eBay listings…':'<span class="spinner"></span>Reading card → verifying exact identity from trusted online sources → condition → eBay…');
    const payload={front:frontForAnalysis,back:backForAnalysis};
    if(lock){
      payload.identityLock=lock;
      payload.identityConfidence=backendAnalysis?.identity_confidence||98;
      payload.identitySources=backendAnalysis?.sources||analysisSnapshot?.analysis?.sources||[];
      payload.serialNumber=$('serialNo')?.value||backendAnalysis?.serial_number||null;
    }
    const j=await analyzeRequest(url,key,payload);
    await applyBackendAnalysis(j,{reidentify});
    const status=j.analysis?.verification_status;
    setIdentifyStatus(status==='verified'||status==='locked'?'Analysis complete · exact identity trusted, pre-grade refreshed, and market refreshed.':'Analysis complete · identity did not pass the trusted-source verification gate.');
    toast(autoIdentityReady?(lastEstimate?'Card re-analyzed and saved':'Card verified; grade withheld where evidence is insufficient'):'Identity needs review');
  }catch(e){console.error(e);setIdentifyStatus(`Analysis failed: ${esc(e.message||String(e))}`);toast('Automatic analysis failed')}
  finally{analysisInFlight=false;$('identifyBtn').disabled=false;if($('reidentifyBtn'))$('reidentifyBtn').disabled=false}
}
async function refreshMarketOnly(){
  if(!autoIdentityReady){toast('Verify the card identity first');return}
  const {url,key}=backendConfig();if(!url||!key){toast('Backend is not configured');return}
  try{
    if($('refreshMarketBtn'))$('refreshMarketBtn').disabled=true;
    // Market refresh must use the verified locked identity, never editable display fields.
    // This prevents a manual typo/correction from contaminating live listing retrieval.
    const locked=lockedIdentityPayload();
    if(!locked)throw new Error('Verified locked identity is unavailable; re-identify the card first');
    const identity=locked;
    const front=frontData?await prepareAnalysisImage('front'):null;
    const r=await fetch(`${url}/market`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({identity,front}),cache:'no-store'});
    const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||`HTTP ${r.status}`);
    marketData=j.market||null;ebayData=j.ebay||null;renderMarket();
    if(currentCardId){
      const card=await dbGet(currentCardId);if(card){card.market=marketData;card.marketRefreshedAt=marketData?.refreshedAt||new Date().toISOString();card.updatedAt=new Date().toISOString();await dbPut(card)}
    }
    toast('eBay listings refreshed');
  }catch(e){console.error(e);toast(`Market refresh failed: ${e.message||e}`)}
  finally{if($('refreshMarketBtn'))$('refreshMarketBtn').disabled=false}
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
  if(!autoIdentityReady||!autoConditionReady||!autoCenteringReady){lastEstimate=null;$('gradeResults').classList.remove('empty');const missing=[!autoIdentityReady?'a verified exact card identity':null,!autoConditionReady?'reliable visible-condition data':null,!autoCenteringReady?'reliable front/back centering':null].filter(Boolean).join(', ').replace(/, ([^,]*)$/,' and $1');$('gradeResults').innerHTML=`<div class="warn"><strong>Automatic grade not available yet.</strong> Card Lab is missing ${esc(missing)} and will not invent a grade.</div>`;return}
  lastEstimate=companyGrades();const e=lastEstimate,q=e.confidence>=80?'good':e.confidence>=60?'warn':'bad';$('gradeResults').classList.remove('empty');$('gradeResults').innerHTML=`<div class="grade-grid"><div class="grade-box"><small>PSA estimate</small><b>${fmtGrade(e.psa,'PSA')}</b><small>whole-number scale</small></div><div class="grade-box"><small>BGS estimate</small><b>${fmtGrade(e.bgs,'BGS')}</b><small>C ${e.bgsSubs.centering} · Co ${e.bgsSubs.corners} · E ${e.bgsSubs.edges} · S ${e.bgsSubs.surface}</small></div><div class="grade-box"><small>CGC estimate</small><b>${fmtGrade(e.cgc,'CGC')}</b><small>published-scale approximation</small></div><div class="grade-box"><small>SGC estimate</small><b>${fmtGrade(e.sgc,'SGC')}</b><small>published-scale approximation</small></div></div><div class="confidence ${q}">Confidence ${e.confidence}% · Front ${e.centering.front.lr[0].toFixed(1)}/${e.centering.front.lr[1].toFixed(1)} L/R, ${e.centering.front.tb[0].toFixed(1)}/${e.centering.front.tb[1].toFixed(1)} T/B · Back ${e.centering.back.lr[0].toFixed(1)}/${e.centering.back.lr[1].toFixed(1)} L/R, ${e.centering.back.tb[0].toFixed(1)}/${e.centering.back.tb[1].toFixed(1)} T/B.</div><div class="hint">Pre-grade estimate only. Microscopic defects, alterations, texture/indentations and in-hand eye appeal may change a professional grade.</div>${e.flags.length?'<ul class="hint">'+e.flags.map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>':''}`;
}

function cardQuery(){return [$('year').value,$('set').value,$('subject').value,$('cardNo').value,$('variation').value].filter(Boolean).join(' ').trim()}
function ebaySearch(){const q=cardQuery(),u=marketData?.searchUrl||ebayData?.searchUrl||(q?`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`:'');if(!u){toast('Card identity is not ready yet');return}window.open(u,'_blank','noopener')}

function cloneData(v){try{return structuredClone(v)}catch{return JSON.parse(JSON.stringify(v??null))}}
function historyId(){return crypto?.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2,9)}`}
function photoKey(){
  const f=frontData?.contentHash||frontData?.fingerprint||'front',b=backData?.contentHash||backData?.fingerprint||'back';
  return `${f}-${b}`;
}
function makeHistoryEntry(){
  return {
    id:historyId(),
    analyzedAt:new Date().toISOString(),
    photoKey:photoKey(),
    identity:cloneData(backendAnalysis?.identity||null),
    verificationStatus:backendAnalysis?.verification_status||null,
    identityConfidence:Number(backendAnalysis?.identity_confidence||0),
    sources:cloneData(backendAnalysis?.sources||[]),
    serialNumber:$('serialNo')?.value||backendAnalysis?.serial_number||null,
    centering:cloneData(centering()),
    centeringMeta:cloneData(centeringMeta),
    condition:cloneData(backendAnalysis?.condition||null),
    estimate:cloneData(lastEstimate),
    market:cloneData(marketData),
    photoQuality:{front:cloneData(frontData?.quality||null),back:cloneData(backData?.quality||null)},
  };
}
function currentRecordBase(){
  if(!lastEstimate&&autoConditionReady&&autoCenteringReady)lastEstimate=companyGrades();
  return {
    updatedAt:new Date().toISOString(),
    year:$('year').value,
    set:$('set').value,
    subject:$('subject').value,
    cardNo:$('cardNo').value,
    variation:$('variation').value,
    serialNo:$('serialNo')?.value||'',
    category:$('category').value,
    cost:+$('cost').value||0,
    notes:$('notes').value,
    front:frontData?.dataUrl||null,
    back:backData?.dataUrl||null,
    frontFingerprint:frontData?.fingerprint||null,
    backFingerprint:backData?.fingerprint||null,
    frontHash:frontData?.contentHash||null,
    backHash:backData?.contentHash||null,
    frontQuality:frontData?.quality||null,
    backQuality:backData?.quality||null,
    identityLocked,
    identification:{backend:cloneData(backendAnalysis),meta:cloneData(analysisMeta),ebay:cloneData(ebayData),market:cloneData(marketData),suggestions:cloneData(ocrSuggestions),frontText:ocrRaw.front,backText:ocrRaw.back},
    analysisSnapshot:cloneData(analysisSnapshot),
    centering:cloneData(centering()),
    centeringMeta:cloneData(centeringMeta),
    scores:cloneData(baseScores()),
    defects:{crease:$('crease').checked,dent:$('dent').checked,stain:$('stain').checked,scratch:$('scratch').checked,printline:$('printline').checked,mark:$('mark').checked,altered:$('altered').checked,confirmed:$('confirmed').checked},
    estimate:cloneData(lastEstimate),
    market:cloneData(marketData),
    marketRefreshedAt:marketData?.refreshedAt||null,
    lastAnalyzedAt:new Date().toISOString(),
  };
}
async function findSamePhysicalCard(){
  const all=await dbAll();
  // Auto-merge only when the exact same saved photo bytes are reused. Similar-looking
  // cards may be separate physical copies and must never be merged automatically.
  if(frontData?.contentHash&&backData?.contentHash){
    const exact=all.find(c=>c.frontHash===frontData.contentHash&&c.backHash===backData.contentHash);
    if(exact)return exact;
  }
  return all.find(c=>c.front===frontData?.dataUrl&&c.back===backData?.dataUrl)||null;
}
async function saveCardAutomatic({appendHistory=true,reidentify=false}={}){
  if(!autoIdentityReady)return;
  const base=currentRecordBase();
  if(!base.subject||!base.cardNo||!base.set)return;

  let existing=currentCardId?await dbGet(currentCardId):null;
  if(!existing){
    const same=await findSamePhysicalCard();
    if(same){existing=same;currentCardId=same.id;identityLocked=true}
  }

  const rec={...(existing||{}),...base};
  rec.createdAt=existing?.createdAt||new Date().toISOString();
  rec.id=existing?.id;
  rec.history=Array.isArray(existing?.history)?[...existing.history]:[];
  rec.photoVersions=existing?.photoVersions&&typeof existing.photoVersions==='object'?{...existing.photoVersions}:{};
  const pKey=photoKey();
  if(!rec.photoVersions[pKey]){
    rec.photoVersions[pKey]={front:frontData?.dataUrl||null,back:backData?.dataUrl||null,frontQuality:cloneData(frontData?.quality||null),backQuality:cloneData(backData?.quality||null),savedAt:new Date().toISOString()};
  }
  if(appendHistory)rec.history.push(makeHistoryEntry());

  if(rec.id){await dbPut(rec);currentCardId=rec.id}else{delete rec.id;currentCardId=await dbAdd(rec)}
  currentHistory=rec.history;identityLocked=true;currentOpenedAt=rec.updatedAt;
  if($('saveStatus'))$('saveStatus').textContent=`Saved locally · card #${currentCardId} · ${rec.history.length} analysis ${rec.history.length===1?'snapshot':'snapshots'} · identity locked`;
  await renderCollection();renderHistory();await persistDraft();
}

function setFormFromSaved(card){
  const fields={year:card.year||'',set:card.set||'',subject:card.subject||'',cardNo:card.cardNo||'',variation:card.variation||'',serialNo:card.serialNo||''};
  for(const [id,v] of Object.entries(fields))if($(id))$(id).value=v;
  if(card.category&&[...$('category').options].some(o=>o.value===card.category))$('category').value=card.category;
  $('cost').value=Number(card.cost)||'';$('notes').value=card.notes||'';
  const s=card.scores||{};for(const [id,k] of [['corners','corners'],['edges','edges'],['surface','surface'],['focusScore','focus']])if(Number.isFinite(Number(s[k])))nearestOption(id,s[k]);
  const d=card.defects||{};for(const id of ['crease','dent','stain','scratch','printline','mark','altered','confirmed'])if($(id))$(id).checked=Boolean(d[id]);
  const cv=card.centering||{};
  for(const side of ['front','back']){
    const v=cv[side],pre=side;
    if(v){$(pre+'BorderL').value=v.L??5;$(pre+'BorderR').value=v.R??5;$(pre+'BorderT').value=v.T??5;$(pre+'BorderB').value=v.B??5}
  }
}
async function openSavedCard(id){
  const card=await dbGet(Number(id));if(!card){toast('Saved card not found');return}
  currentCardId=card.id;identityLocked=savedIdentityTrusted(card);currentHistory=Array.isArray(card.history)?card.history:[];currentOpenedAt=card.updatedAt||card.createdAt||null;
  frontData=card.front?{dataUrl:card.front,quality:card.frontQuality||{score:0,glare:0,sharp:0},bounds:null,fingerprint:card.frontFingerprint||null,contentHash:card.frontHash||null}:null;
  backData=card.back?{dataUrl:card.back,quality:card.backQuality||{score:0,glare:0,sharp:0},bounds:null,fingerprint:card.backFingerprint||null,contentHash:card.backHash||null}:null;
  if(frontData)showStoredPhoto('front',frontData);if(backData)showStoredPhoto('back',backData);
  setFormFromSaved(card);
  backendAnalysis=card.identification?.backend||null;analysisMeta=card.identification?.meta||null;ebayData=card.identification?.ebay||null;marketData=card.market||card.identification?.market||null;analysisSnapshot=card.analysisSnapshot||null;
  centeringMeta=card.centeringMeta||{front:null,back:null};lastEstimate=card.estimate||null;
  const status=backendAnalysis?.verification_status||'unverified';autoIdentityReady=Boolean(identityLocked&&card.year&&card.set&&card.subject&&card.cardNo);autoConditionReady=backendConditionReady()||Boolean(card.defects?.confirmed);
  updateCentering();renderConditionSummary();renderEstimate();if(backendAnalysis)renderBackendSummary(backendAnalysis,ebayData);renderMarket();renderHistory();
  if($('saveStatus'))$('saveStatus').textContent=identityLocked?`Saved locally · card #${card.id} · ${currentHistory.length} analysis ${currentHistory.length===1?'snapshot':'snapshots'} · verified identity locked`:`Saved locally · card #${card.id} · legacy/unverified identity must be verified by Card Lab 3.0`;
  setIdentifyStatus(identityLocked?'Saved card opened · Re-analyze refreshes condition, grades, and eBay while keeping the verified identity. Use Re-identify only if the identity is wrong.':'Saved card opened from an older/unverified analysis · tap Re-identify card once to verify it with the Card Lab 3.0 source pipeline.');
  document.querySelector('[data-tab="grade"]').click();window.scrollTo({top:0,behavior:'smooth'});await persistDraft();
}
async function deleteHistoryEntry(entryId){
  if(!currentCardId)return;
  const card=await dbGet(currentCardId);if(!card)return;
  const before=Array.isArray(card.history)?card.history.length:0;
  card.history=(card.history||[]).filter(x=>x.id!==entryId);
  if(card.photoVersions&&typeof card.photoVersions==='object'){
    const keep=new Set((card.history||[]).map(x=>x.photoKey).filter(Boolean));
    const currentKey=card.frontHash&&card.backHash?`${card.frontHash}-${card.backHash}`:(card.frontFingerprint&&card.backFingerprint?`${card.frontFingerprint}-${card.backFingerprint}`:null);if(currentKey)keep.add(currentKey);
    for(const k of Object.keys(card.photoVersions))if(!keep.has(k))delete card.photoVersions[k];
  }
  card.updatedAt=new Date().toISOString();await dbPut(card);currentHistory=card.history;renderHistory();
  toast(before!==card.history.length?'History entry deleted':'History entry not found');
}
function renderHistory(){
  const root=$('historyList'),summary=$('historySummary');if(!root)return;
  const rows=[...(currentHistory||[])].sort((a,b)=>new Date(b.analyzedAt)-new Date(a.analyzedAt));
  if(summary)summary.textContent=currentCardId?`${rows.length} saved analysis ${rows.length===1?'snapshot':'snapshots'} for card #${currentCardId}`:'History begins after a verified card is saved.';
  if(!rows.length){root.innerHTML='<div class="hint">No saved analysis history yet.</div>';return}
  root.innerHTML=rows.map((h,idx)=>{
    const e=h.estimate||{},c=h.centering||{},raw=h.market?.stats?.raw;
    const grades=[`PSA ${fmtGrade(e.psa??'-','PSA')}`,`BGS ${fmtGrade(e.bgs??'-','BGS')}`,`CGC ${fmtGrade(e.cgc??'-','CGC')}`,`SGC ${fmtGrade(e.sgc??'-','SGC')}`].join(' · ');
    const cent=c.front?.lr?`Front ${c.front.lr[0].toFixed(1)}/${c.front.lr[1].toFixed(1)} · Back ${c.back?.lr?.[0]?.toFixed?.(1)??'-'}/${c.back?.lr?.[1]?.toFixed?.(1)??'-'}`:'Centering unavailable';
    const market=raw?`Raw eBay median ${formatMoney(raw.median)} (${raw.sampleSize})`:'No raw market snapshot';
    return `<div class="history-item"><div><strong>${esc(formatDateTime(h.analyzedAt))}${idx===0?' · newest':''}</strong><div class="hint">${esc(grades)}</div><div class="hint">${esc(cent)} · ${esc(market)}</div></div><button class="danger compact" data-history-delete="${esc(h.id)}">Delete</button></div>`;
  }).join('');
  root.querySelectorAll('[data-history-delete]').forEach(b=>b.onclick=async()=>{if(confirm('Delete only this analysis-history entry? The card and other history entries will remain.'))await deleteHistoryEntry(b.dataset.historyDelete)});
}

async function resetForm(){
  document.querySelectorAll('#grade input[type=text],#grade input[type=number]').forEach(x=>x.value='');
  ['frontBorderL','frontBorderR','frontBorderT','frontBorderB','backBorderL','backBorderR','backBorderT','backBorderB'].forEach(id=>$(id).value=5);
  document.querySelectorAll('#grade input[type=checkbox]').forEach(x=>x.checked=false);
  $('corners').value=$('edges').value=$('surface').value='9';$('focusScore').value='9';$('category').value='Sports';
  $('frontPreview').style.display=$('backPreview').style.display='none';
  ['frontCameraInput','frontLibraryInput','backCameraInput','backLibraryInput'].forEach(id=>{if($(id))$(id).value=''});
  if($('frontSavedStatus'))$('frontSavedStatus').textContent='No photo saved yet';if($('backSavedStatus'))$('backSavedStatus').textContent='No photo saved yet';$('frontQuality').innerHTML=$('backQuality').innerHTML='';
  frontData=backData=lastEstimate=null;analysisSnapshot=backendAnalysis=analysisMeta=ebayData=marketData=null;currentCardId=null;identityLocked=false;currentHistory=[];currentOpenedAt=null;marketFilter='raw';
  centeringMeta={front:null,back:null};autoIdentityReady=autoCenteringReady=autoConditionReady=false;
  await draftClear();$('identifyResults').classList.add('hidden');
  setIdentifyStatus('Add front and back photos. Card Lab will verify the exact card from trusted online sources before grading or saving it.');
  $('gradeResults').className='results empty';$('gradeResults').textContent='Add front and back photos. Grade estimates will appear automatically.';
  if($('marketResults')){$('marketResults').className='results empty';$('marketResults').textContent='Verified current listing matches will appear automatically after identification.'}
  if($('conditionAutoSummary'))$('conditionAutoSummary').textContent='Waiting for analysis.';
  if($('saveStatus'))$('saveStatus').textContent='A card is saved automatically only after exact identity verification.';
  renderHistory();updateCentering();window.scrollTo({top:0,behavior:'smooth'});
}

async function renderCollection(){
  const all=await dbAll(),term=($('collectionSearch').value||'').toLowerCase();
  const rows=all.filter(c=>JSON.stringify([c.year,c.set,c.subject,c.cardNo,c.variation,c.serialNo]).toLowerCase().includes(term)).sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0));
  $('collectionStats').textContent=`${all.length} card${all.length===1?'':'s'} stored locally`;
  const root=$('collectionList');if(!rows.length){root.innerHTML='<div class="card-block hint">No matching cards.</div>';return}
  root.innerHTML=rows.map(c=>{
    const med=c.market?.stats?.raw?.median,historyCount=Array.isArray(c.history)?c.history.length:0;
    return `<div class="collection-card clickable" data-open="${c.id}">
      <img src="${esc(c.front||'')}" alt="">
      <div><div class="collection-title">${esc([c.year,c.subject].filter(Boolean).join(' ')||'Untitled card')}</div>
      <div class="collection-sub">${esc([c.set,c.cardNo?`#${c.cardNo}`:null,c.variation,c.serialNo].filter(Boolean).join(' · '))}</div>
      <div><span class="pill">PSA ${fmtGrade(c.estimate?.psa??'-','PSA')}</span><span class="pill">BGS ${fmtGrade(c.estimate?.bgs??'-','BGS')}</span><span class="pill">CGC ${fmtGrade(c.estimate?.cgc??'-','CGC')}</span><span class="pill">SGC ${fmtGrade(c.estimate?.sgc??'-','SGC')}</span></div>
      <div class="hint">${med!=null?`Raw median ${formatMoney(med)} · `:''}${historyCount} history · ${c.lastAnalyzedAt?`analyzed ${esc(formatDateTime(c.lastAnalyzedAt))}`:'not analyzed'}</div></div>
      <div class="collection-actions"><button class="primary compact" data-open-button="${c.id}">Open</button><button class="secondary compact" data-ebay="${c.id}">eBay</button><button class="danger compact" data-del="${c.id}">Delete</button></div>
    </div>`;
  }).join('');
  root.querySelectorAll('[data-open]').forEach(el=>el.onclick=e=>{if(e.target.closest('button'))return;openSavedCard(+el.dataset.open)});
  root.querySelectorAll('[data-open-button]').forEach(b=>b.onclick=e=>{e.stopPropagation();openSavedCard(+b.dataset.openButton)});
  root.querySelectorAll('[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(confirm('Delete this card and all of its analysis history from the local collection?')){if(currentCardId===+b.dataset.del)await resetForm();await dbDelete(+b.dataset.del);renderCollection()}});
  root.querySelectorAll('[data-ebay]').forEach(b=>b.onclick=e=>{e.stopPropagation();const c=rows.find(x=>x.id===+b.dataset.ebay),u=c?.market?.searchUrl||`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent([c.year,c.set,c.subject,c.cardNo,c.variation].filter(Boolean).join(' '))}`;window.open(u,'_blank','noopener')});
}


function downloadJson(obj,name){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
async function exportBackup(){const data=await dbAll();downloadJson({version:4,type:'collection',exportedAt:new Date().toISOString(),cards:data},`card-lab-collection-${new Date().toISOString().slice(0,10)}.json`)}
async function exportRecovery(){if(!confirm('Full recovery contains your private Cloudflare API key and draft card photos. Export and store it securely?'))return;const data=await dbAll(),draft=await draftGet();downloadJson({version:4,type:'full-recovery',exportedAt:new Date().toISOString(),cards:data,draft,settings:{backendUrl:localStorage.getItem('cardlab.backendUrl')||'',backendKey:localStorage.getItem('cardlab.backendKey')||''}},`card-lab-full-recovery-${new Date().toISOString().slice(0,10)}.json`);toast('Full recovery exported')}
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
  $('identifyBtn').onclick=()=>identifyFromPhotos(false);if($('reidentifyBtn'))$('reidentifyBtn').onclick=()=>identifyFromPhotos(true);if($('refreshMarketBtn'))$('refreshMarketBtn').onclick=refreshMarketOnly;$('ebayBtn').onclick=ebaySearch;$('saveBackendBtn').onclick=saveBackendSettings;$('testBackendBtn').onclick=testBackend;$('resetBtn').onclick=resetForm;$('collectionSearch').oninput=renderCollection;$('exportBtn').onclick=exportBackup;if($('exportRecoveryBtn'))$('exportRecoveryBtn').onclick=exportRecovery;if($('checkUpdateBtn'))$('checkUpdateBtn').onclick=()=>checkForUpdate(true);$('importInput').onchange=()=>{const f=$('importInput').files?.[0];if(f)importBackup(f)};$('clearBtn').onclick=async()=>{if(confirm('Erase the entire local card collection? This cannot be undone unless you exported a backup.')){await dbClear();renderCollection();toast('Collection erased')}};
  if($('marketTabs'))$('marketTabs').querySelectorAll('[data-market-filter]').forEach(b=>b.onclick=()=>{marketFilter=b.dataset.marketFilter||'raw';renderMarket()});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('installBtn').classList.add('hidden')}else toast('Use your browser Add to Home Screen option')};
}

(async function init(){await openDB();bind();loadBackendSettings();updateCentering();await restoreDraft();await requestPersistentStorage();await registerUpdater();setTimeout(()=>checkForUpdate(false),1000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkForUpdate(false)});window.addEventListener('pageshow',()=>checkForUpdate(false))})();
