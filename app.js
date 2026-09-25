'use strict';
const $=id=>document.getElementById(id);
let db, frontData=null, backData=null, lastEstimate=null, deferredPrompt=null, ocrRaw={front:'',back:''}, ocrSuggestions={};
const DB='cardLabDB', STORE='cards';

function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function roundHalf(n){return Math.round(n*2)/2}
function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
function pctPair(a,b){const total=a+b;if(!total)return [50,50];const p=a/total*100;return [p,100-p]}
function worstSplit(a,b){const [x,y]=pctPair(a,b);return Math.max(x,y)}

function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});s.createIndex('subject','subject')}};r.onsuccess=()=>{db=r.result;res(db)};r.onerror=()=>rej(r.error)})}
function tx(mode='readonly'){return db.transaction(STORE,mode).objectStore(STORE)}
function dbAdd(v){return new Promise((res,rej)=>{const r=tx('readwrite').add(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbPut(v){return new Promise((res,rej)=>{const r=tx('readwrite').put(v);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbAll(){return new Promise((res,rej)=>{const r=tx().getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function dbDelete(id){return new Promise((res,rej)=>{const r=tx('readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function dbClear(){return new Promise((res,rej)=>{const r=tx('readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

async function compressImage(file,max=1600,q=.82){
  const bitmap=await createImageBitmap(file); const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const c=document.createElement('canvas');c.width=Math.round(bitmap.width*scale);c.height=Math.round(bitmap.height*scale);
  c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
  const dataUrl=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob)});
  return {dataUrl,w:c.width,h:c.height,quality:analyzeQuality(c)};
}
function analyzeQuality(c){
  const ctx=c.getContext('2d',{willReadFrequently:true});const W=Math.min(500,c.width),H=Math.round(c.height*W/c.width);const s=document.createElement('canvas');s.width=W;s.height=H;const x=s.getContext('2d',{willReadFrequently:true});x.drawImage(c,0,0,W,H);const d=x.getImageData(0,0,W,H).data;
  let lum=0,clip=0,grad=0,count=0; const gray=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++){const y=.299*d[i]+.587*d[i+1]+.114*d[i+2];gray[j]=y;lum+=y;if(y>248)clip++}
  for(let y=1;y<H-1;y+=2)for(let xx=1;xx<W-1;xx+=2){const i=y*W+xx;grad+=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+W]-gray[i-W]);count++}
  const avg=lum/(W*H), glare=clip/(W*H), sharp=grad/count;
  let score=100;if(avg<55||avg>220)score-=25;if(glare>.05)score-=25;else if(glare>.02)score-=10;if(sharp<12)score-=25;else if(sharp<20)score-=10;if(c.width<900)score-=15;
  return {score:clamp(Math.round(score),0,100),brightness:Math.round(avg),glare:+(glare*100).toFixed(1),sharp:+sharp.toFixed(1)};
}
function qualityText(q){const cls=q.score>=80?'good':q.score>=60?'warn':'bad';return `<span class="${cls}">Photo quality ${q.score}/100</span> · glare ${q.glare}% · sharpness ${q.sharp}`}
async function handlePhoto(input,preview,quality,side){
  const f=input.files?.[0];if(!f)return;try{const o=await compressImage(f);$(preview).src=o.dataUrl;$(preview).style.display='block';$(quality).innerHTML=qualityText(o.quality);if(side==='front')frontData=o;else backData=o;ocrRaw[side]='';ocrSuggestions={};$('identifyResults').classList.add('hidden');toast(`${side} photo ready`)}catch(e){toast('Could not process photo')}
}

function setIdentifyStatus(html){$('identifyStatus').innerHTML=html}
function normalizeOCRText(t=''){return t.replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{2,}/g,'\n').trim()}
function cleanLines(t=''){return normalizeOCRText(t).split('\n').map(x=>x.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9#'&./-]+$/g,'')).filter(Boolean)}
function detectYear(text=''){const now=new Date().getFullYear()+1;const years=[...text.matchAll(/\b(19[4-9]\d|20[0-3]\d)\b/g)].map(m=>+m[1]).filter(y=>y<=now);return years.length?String(Math.max(...years)):''}
function detectCardNo(text=''){const pats=[/(?:CARD\s*)?(?:NO\.?|NUMBER|#)\s*[:.-]?\s*([A-Z0-9-]{1,12})/i,/\bNO\.?\s*([A-Z0-9-]{1,12})\b/i];for(const r of pats){const m=text.match(r);if(m)return m[1].replace(/^#/,'')}return ''}
const BRAND_PATTERNS=[
  [/\bTOPPS\s+CHROME\b/i,'Topps Chrome'],[/\bTOPPS\s+HERITAGE\b/i,'Topps Heritage'],[/\bSTADIUM\s+CLUB\b/i,'Stadium Club'],[/\bBOWMAN\s+CHROME\b/i,'Bowman Chrome'],[/\bDONRUSS\s+OPTIC\b/i,'Donruss Optic'],[/\bPANINI\s+PRIZM\b/i,'Panini Prizm'],[/\bPANINI\s+SELECT\b/i,'Panini Select'],[/\bPANINI\s+MOSAIC\b/i,'Panini Mosaic'],[/\bUPPER\s+DECK\b/i,'Upper Deck'],[/\bTOPPS\b/i,'Topps'],[/\bBOWMAN\b/i,'Bowman'],[/\bDONRUSS\b/i,'Donruss'],[/\bPANINI\b/i,'Panini'],[/\bFLEER\b/i,'Fleer'],[/\bSCORE\b/i,'Score']
];
function detectSet(text=''){for(const [r,label] of BRAND_PATTERNS)if(r.test(text))return label;return ''}
function detectSubject(frontText='',backText=''){
  const excluded=/\b(TOPPS|BOWMAN|DONRUSS|PANINI|PRIZM|OPTIC|SELECT|MOSAIC|UPPER|DECK|FLEER|SCORE|CHROME|HERITAGE|STADIUM|CLUB|ROOKIE|CARD|NO|NUMBER|COPYRIGHT|MAJOR|LEAGUE|BASEBALL|FOOTBALL|BASKETBALL|HOCKEY|TRADING|CONGRATULATIONS|AUTHENTIC|AUTOGRAPH|MEMORABILIA|INC|LLC)\b/i;
  const lines=cleanLines(frontText).concat(cleanLines(backText).slice(0,8));
  let best='',score=-99;
  for(const line of lines){if(line.length<4||line.length>36||/\d{3,}/.test(line)||excluded.test(line))continue;const words=line.split(/\s+/);if(words.length<1||words.length>4)continue;if(!words.every(w=>/^[A-Za-z.'-]{2,}$/.test(w)))continue;let sc=0;if(words.length===2)sc+=5;else if(words.length===3)sc+=3;sc+=Math.min(4,line.length/8);if(/^[A-Z .'-]+$/.test(line))sc+=2;if(sc>score){score=sc;best=line.replace(/\b\w/g,m=>m.toUpperCase())}}
  return best;
}
function inferFromOCR(frontText,backText){const all=`${frontText}\n${backText}`;return {year:detectYear(all),set:detectSet(all),subject:detectSubject(frontText,backText),cardNo:detectCardNo(backText)||detectCardNo(frontText)}}
function applySuggestions(s){ocrSuggestions=s;for(const [id,val] of Object.entries({year:s.year,set:s.set,subject:s.subject,cardNo:s.cardNo})){if(val&&!$(id).value)$(id).value=val}const parts=[s.year,s.set,s.subject,s.cardNo?`#${s.cardNo}`:''].filter(Boolean);$('identifyResults').classList.remove('hidden');$('identifyResults').innerHTML=`<div class="suggestion">Suggested: ${esc(parts.join(' · ')||'No confident fields found')}</div><div class="hint">Review/correct the fields above before grading or saving. OCR is weakest on foil, stylized fonts and glare.</div><details><summary>Show OCR text</summary><pre>${esc(`FRONT\n${ocrRaw.front||'(none)'}\n\nBACK\n${ocrRaw.back||'(none)'}`)}</pre></details>`}
async function identifyFromPhotos(){if(!frontData&&!backData){toast('Take at least one card photo first');return}let worker=null;let side='Front';try{$('identifyBtn').disabled=true;setIdentifyStatus('<span class="spinner"></span>Loading OCR…');if(!window.Tesseract)throw new Error('OCR engine unavailable');worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status==='recognizing text'){const pct=Math.round((m.progress||0)*100);setIdentifyStatus(`<span class="spinner"></span>${side} OCR ${pct}%`)}}});if(frontData){side='Front';const r=await worker.recognize(frontData.dataUrl);ocrRaw.front=normalizeOCRText(r.data?.text||'')}else ocrRaw.front='';if(backData){side='Back';const r=await worker.recognize(backData.dataUrl);ocrRaw.back=normalizeOCRText(r.data?.text||'')}else ocrRaw.back='';const s=inferFromOCR(ocrRaw.front,ocrRaw.back);applySuggestions(s);setIdentifyStatus('Identification complete · processed on this device');toast('Review the suggested card details')}catch(e){console.error(e);setIdentifyStatus('OCR could not run. Check your internet connection and try again.');toast('Identification failed')}finally{if(worker)try{await worker.terminate()}catch{}$('identifyBtn').disabled=false}}

async function autoBorders(side){
  const data=side==='front'?frontData:backData;if(!data){toast(`Take the ${side} photo first`);return}
  const img=new Image();img.src=data.dataUrl;await img.decode();const W=420,H=Math.round(img.height*W/img.width);const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);const d=ctx.getImageData(0,0,W,H).data;const g=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++)g[j]=.299*d[i]+.587*d[i+1]+.114*d[i+2];
  const v=new Float32Array(W),h=new Float32Array(H);
  for(let x=2;x<W-2;x++){let sum=0;for(let y=Math.round(H*.12);y<H*.88;y+=3){const i=y*W+x;sum+=Math.abs(g[i+2]-g[i-2])}v[x]=sum}
  for(let y=2;y<H-2;y++){let sum=0;for(let x=Math.round(W*.12);x<W*.88;x+=3){const i=y*W+x;sum+=Math.abs(g[i+2*W]-g[i-2*W])}h[y]=sum}
  const peak=(arr,a,b)=>{let m=-1,mi=a;for(let i=Math.floor(a);i<Math.floor(b);i++)if(arr[i]>m){m=arr[i];mi=i}return [mi,m]};
  const [L,lm]=peak(v,W*.03,W*.28),[R,rm]=peak(v,W*.72,W*.97),[T,tm]=peak(h,H*.03,H*.28),[B,bm]=peak(h,H*.72,H*.97);
  const pre=side==='front'?'front':'back';$(pre+'BorderL').value=(L/W*100).toFixed(1);$(pre+'BorderR').value=((W-R)/W*100).toFixed(1);$(pre+'BorderT').value=(T/H*100).toFixed(1);$(pre+'BorderB').value=((H-B)/H*100).toFixed(1);
  const conf=clamp(Math.round(((lm+rm+tm+bm)/4)/900*100),20,90);updateCentering();toast(`${side} border estimate · confidence ${conf}%`)
}
function centeringSide(side){const pre=side==='front'?'front':'back';const L=+$(pre+'BorderL').value||0,R=+$(pre+'BorderR').value||0,T=+$(pre+'BorderT').value||0,B=+$(pre+'BorderB').value||0;const lr=pctPair(L,R),tb=pctPair(T,B);return {L,R,T,B,lr,tb,worst:Math.max(...lr,...tb)}}
function centering(){return {front:centeringSide('front'),back:centeringSide('back')}}
function updateCentering(){for(const side of ['front','back']){const c=centeringSide(side);$(side+'CenteringReadout').textContent=`L/R ${c.lr[0].toFixed(1)}/${c.lr[1].toFixed(1)} · T/B ${c.tb[0].toFixed(1)}/${c.tb[1].toFixed(1)}`}}

function baseScores(){return {corners:+$('corners').value,edges:+$('edges').value,surface:+$('surface').value,focus:+$('focusScore').value}}
function defectCaps(){
  let cap=10, flags=[];
  if($('altered').checked){cap=0;flags.push('Possible alteration/restoration: professional graders may return No Grade/Authentic rather than a numeric grade.')}
  if($('crease').checked){cap=Math.min(cap,5);flags.push('Crease/wrinkle strongly caps high grades.')}
  if($('dent').checked){cap=Math.min(cap,7);flags.push('Dent/indentation caps high grades even if difficult to photograph.')}
  if($('stain').checked){cap=Math.min(cap,7);flags.push('Staining/discoloration limits upper grades.')}
  if($('scratch').checked){cap=Math.min(cap,8);flags.push('Noticeable surface scratch limits upper grades.')}
  if($('printline').checked){cap=Math.min(cap,9);flags.push('Print/refractor line affects surface grade.')}
  if($('mark').checked){cap=Math.min(cap,6);flags.push('Writing/marks may receive a qualifier or substantially lower grade.')}
  return {cap,flags}
}
function gradeCapFromThreshold(worst, rows){for(const [limit,grade] of rows)if(worst<=limit)return grade;return rows[rows.length-1][1]}
function centerCaps(c){
  const fw=c.front.worst,bw=c.back.worst;
  const psaFront=gradeCapFromThreshold(fw,[[55,10],[60,9],[70,8],[75,7],[80,6],[85,5],[90,3],[100,1]]);
  const psaBack=gradeCapFromThreshold(bw,[[75,10],[90,8],[95,6],[100,4]]);
  const psa=Math.min(psaFront,psaBack);
  const fAxes=[c.front.lr,c.front.tb].map(a=>Math.max(...a)).sort((a,b)=>a-b);
  let bgsFront;if(fAxes[1]<=50.5)bgsFront=10;else if(fAxes[0]<=50.5&&fAxes[1]<=55)bgsFront=9.5;else bgsFront=gradeCapFromThreshold(fw,[[55,9],[60,8],[65,7],[70,6],[75,5],[80,4],[85,3],[90,2],[100,1]]);
  const bgsBack=gradeCapFromThreshold(bw,[[55,10],[60,9.5],[70,9],[80,8],[90,7],[95,6],[100,4]]);
  const bgs=Math.min(bgsFront,bgsBack);
  const cgcFront=gradeCapFromThreshold(fw,[[50.5,10],[55,10],[60,9],[65,8],[70,7],[75,6],[80,5],[85,4],[90,3],[100,1]]);
  const cgcBack=gradeCapFromThreshold(bw,[[75,10],[90,9],[95,7],[100,5]]);
  const cgc=Math.min(cgcFront,cgcBack);
  // SGC publishes descriptive condition standards; use a conservative centering cap anchored to its Pristine 10 = 50/50 criterion.
  const sgcFront=gradeCapFromThreshold(fw,[[50.5,10],[55,10],[60,9.5],[65,9],[70,8],[75,7],[80,6],[85,5],[90,3],[100,1]]);
  const sgcBack=gradeCapFromThreshold(bw,[[75,10],[90,9],[95,7],[100,5]]);
  return {psa,bgs,cgc,sgc:Math.min(sgcFront,sgcBack)}
}

function companyGrades(){
  const s=baseScores(), c=centering(), cc=centerCaps(c), dc=defectCaps();
  const core=Math.min(s.corners,s.edges,s.surface,s.focus,dc.cap||10);
  const avg=(s.corners+s.edges+s.surface+s.focus)/4;
  let psa=Math.min(cc.psa,dc.cap||10,Math.floor(Math.min(10,(core*.72+avg*.28)+.35)));
  if(dc.cap===0)psa=0;
  // BGS: lowest subgrade is heavily weighted; final usually no more than 0.5-1.0 above the lowest.
  const bgsSubs=[Math.min(cc.bgs,10),s.corners,s.edges,s.surface];const low=Math.min(...bgsSubs,dc.cap||10);const bavg=bgsSubs.reduce((a,b)=>a+b,0)/4;let bgs=roundHalf(Math.min(cc.bgs,dc.cap||10,low+Math.min(1,Math.max(0,(bavg-low)*.45))));
  if(bgs===10 && !bgsSubs.every(x=>x>=10))bgs=9.5;if(dc.cap===0)bgs=0;
  const cgcCore=Math.min(s.corners,s.edges,s.surface,s.focus);let cgc=roundHalf(Math.min(cc.cgc,dc.cap||10,cgcCore+.25));if(cgc>9.5&&c.front.worst>55)cgc=9.5;if(dc.cap===0)cgc=0;
  const sgcCore=Math.min(s.corners,s.edges,s.surface,s.focus);let sgc=roundHalf(Math.min(cc.sgc,dc.cap||10,sgcCore+.25));if(dc.cap===0)sgc=0;
  const q=[frontData?.quality.score||0,backData?.quality.score||0].filter(Boolean);const qavg=q.length?q.reduce((a,b)=>a+b,0)/q.length:0;let confidence=Math.round(qavg*.55+($('confirmed').checked?35:10)+(frontData&&backData?10:0));confidence=clamp(confidence,10,95);
  return {psa,bgs,cgc,sgc,bgsSubs:{centering:bgsSubs[0],corners:s.corners,edges:s.edges,surface:s.surface},centering:c,flags:dc.flags,confidence};
}
function fmtGrade(g,company){if(g===0)return 'NG?';if(company==='SGC'&&g===10)return '10';return String(g)}
function renderEstimate(){lastEstimate=companyGrades();const e=lastEstimate;const q=e.confidence>=80?'good':e.confidence>=60?'warn':'bad';$('gradeResults').classList.remove('empty');$('gradeResults').innerHTML=`<div class="grade-grid">
  <div class="grade-box"><small>PSA estimate</small><b>${fmtGrade(e.psa,'PSA')}</b><small>whole-number scale</small></div>
  <div class="grade-box"><small>BGS estimate</small><b>${fmtGrade(e.bgs,'BGS')}</b><small>C ${e.bgsSubs.centering} · Co ${e.bgsSubs.corners} · E ${e.bgsSubs.edges} · S ${e.bgsSubs.surface}</small></div>
  <div class="grade-box"><small>CGC estimate</small><b>${fmtGrade(e.cgc,'CGC')}</b><small>published-scale approximation</small></div>
  <div class="grade-box"><small>SGC estimate</small><b>${fmtGrade(e.sgc,'SGC')}</b><small>published-scale approximation</small></div>
</div><div class="confidence ${q}">Confidence ${e.confidence}% · Front ${e.centering.front.lr[0].toFixed(1)}/${e.centering.front.lr[1].toFixed(1)} L/R, ${e.centering.front.tb[0].toFixed(1)}/${e.centering.front.tb[1].toFixed(1)} T/B · Back ${e.centering.back.lr[0].toFixed(1)}/${e.centering.back.lr[1].toFixed(1)} L/R, ${e.centering.back.tb[0].toFixed(1)}/${e.centering.back.tb[1].toFixed(1)} T/B.</div>${e.flags.length?'<ul class="hint">'+e.flags.map(x=>`<li>${x}</li>`).join('')+'</ul>':''}`}

function cardQuery(){return [$('year').value,$('set').value,$('subject').value,$('cardNo').value,$('variation').value].filter(Boolean).join(' ').trim()}
function ebaySearch(){const q=cardQuery();if(!q){toast('Add card details first');return}window.open(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,'_blank','noopener')}
function currentRecord(){if(!lastEstimate)lastEstimate=companyGrades();return {createdAt:new Date().toISOString(),year:$('year').value,set:$('set').value,subject:$('subject').value,cardNo:$('cardNo').value,variation:$('variation').value,category:$('category').value,cost:+$('cost').value||0,notes:$('notes').value,front:frontData?.dataUrl||null,back:backData?.dataUrl||null,frontQuality:frontData?.quality||null,backQuality:backData?.quality||null,identification:{suggestions:ocrSuggestions,frontText:ocrRaw.front,backText:ocrRaw.back},centering:centering(),scores:baseScores(),defects:{crease:$('crease').checked,dent:$('dent').checked,stain:$('stain').checked,scratch:$('scratch').checked,printline:$('printline').checked,mark:$('mark').checked,altered:$('altered').checked,confirmed:$('confirmed').checked},estimate:lastEstimate}}
async function saveCard(){if(!$('subject').value&&!$('set').value){toast('Add at least a subject or set');return}const id=await dbAdd(currentRecord());toast(`Saved card #${id}`);await renderCollection()}
function resetForm(){document.querySelectorAll('#grade input[type=text],#grade input[type=number]').forEach(x=>x.value='');['frontBorderL','frontBorderR','frontBorderT','frontBorderB','backBorderL','backBorderR','backBorderT','backBorderB'].forEach(id=>$(id).value=5);document.querySelectorAll('#grade input[type=checkbox]').forEach(x=>x.checked=false);$('corners').value=$('edges').value=$('surface').value='9';$('focusScore').value='9';$('frontPreview').style.display=$('backPreview').style.display='none';$('frontInput').value=$('backInput').value='';$('frontQuality').innerHTML=$('backQuality').innerHTML='';frontData=backData=lastEstimate=null;ocrRaw={front:'',back:''};ocrSuggestions={};$('identifyResults').classList.add('hidden');setIdentifyStatus('Uses on-device OCR. First use requires internet to load the OCR engine.');$('gradeResults').className='results empty';$('gradeResults').textContent='Add photos and condition details, then estimate.';updateCentering();window.scrollTo({top:0,behavior:'smooth'})}
async function renderCollection(){const all=await dbAll();const term=($('collectionSearch').value||'').toLowerCase();const rows=all.filter(c=>JSON.stringify([c.year,c.set,c.subject,c.cardNo,c.variation]).toLowerCase().includes(term)).sort((a,b)=>b.id-a.id);$('collectionStats').textContent=`${all.length} card${all.length===1?'':'s'} stored locally`;const root=$('collectionList');if(!rows.length){root.innerHTML='<div class="card-block hint">No matching cards.</div>';return}root.innerHTML=rows.map(c=>`<div class="collection-card"><img src="${c.front||''}" alt=""><div><div class="collection-title">${esc([c.year,c.subject].filter(Boolean).join(' ')||'Untitled card')}</div><div class="collection-sub">${esc([c.set,c.cardNo,c.variation].filter(Boolean).join(' · '))}</div><span class="pill">PSA ${fmtGrade(c.estimate?.psa??'-','PSA')}</span><span class="pill">BGS ${fmtGrade(c.estimate?.bgs??'-','BGS')}</span><span class="pill">CGC ${fmtGrade(c.estimate?.cgc??'-','CGC')}</span><span class="pill">SGC ${fmtGrade(c.estimate?.sgc??'-','SGC')}</span></div><div class="collection-actions"><button class="secondary" data-ebay="${c.id}">eBay</button><button class="danger" data-del="${c.id}">Delete</button></div></div>`).join('');root.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this card from the local collection?')){await dbDelete(+b.dataset.del);renderCollection()}});root.querySelectorAll('[data-ebay]').forEach(b=>b.onclick=()=>{const c=rows.find(x=>x.id===+b.dataset.ebay);const q=[c.year,c.set,c.subject,c.cardNo,c.variation].filter(Boolean).join(' ');window.open(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,'_blank','noopener')})}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function exportBackup(){const data=await dbAll();const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),cards:data},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`card-lab-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href)}
async function importBackup(file){try{const j=JSON.parse(await file.text());if(!Array.isArray(j.cards))throw 0;for(const c of j.cards){delete c.id;await dbAdd(c)}toast(`Imported ${j.cards.length} cards`);renderCollection()}catch{toast('Invalid backup file')}}

function bind(){
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));b.classList.add('active');$(b.dataset.tab).classList.add('active');if(b.dataset.tab==='collection')renderCollection()});
  $('frontInput').onchange=()=>handlePhoto($('frontInput'),'frontPreview','frontQuality','front');$('backInput').onchange=()=>handlePhoto($('backInput'),'backPreview','backQuality','back');$('autoFrontCenterBtn').onclick=()=>autoBorders('front');$('autoBackCenterBtn').onclick=()=>autoBorders('back');['frontBorderL','frontBorderR','frontBorderT','frontBorderB','backBorderL','backBorderR','backBorderT','backBorderB'].forEach(id=>$(id).oninput=updateCentering);$('identifyBtn').onclick=identifyFromPhotos;$('gradeBtn').onclick=renderEstimate;$('ebayBtn').onclick=ebaySearch;$('saveBtn').onclick=saveCard;$('resetBtn').onclick=resetForm;$('collectionSearch').oninput=renderCollection;$('exportBtn').onclick=exportBackup;$('importInput').onchange=()=>{const f=$('importInput').files?.[0];if(f)importBackup(f)};$('clearBtn').onclick=async()=>{if(confirm('Erase the entire local card collection? This cannot be undone unless you exported a backup.')){await dbClear();renderCollection();toast('Collection erased')}};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('installBtn').classList.add('hidden')}else toast('Use your browser Add to Home Screen option')};
}
(async function init(){await openDB();bind();updateCentering();if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});})();
