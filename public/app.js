// ===================== STATE =====================
const MODEL_META = {
    'gemini-flash': { type:'image', cost:1 },
    'gemini-pro':   { type:'image', cost:2 },
    'veo3.1-fast':  { type:'video', cost:2 },
    'veo-extend':   { type:'video', cost:2 },
    'grok-720p-6s': { type:'video', cost:2 },
    'grok-720p-10s':{ type:'video', cost:2 },
    'grok-extend':  { type:'video', cost:2 }
};
let mode = 'image';
let imgCount = 1;
let vidCount = 1;
let uploadedRefs = [];
let startFrameFile = null;
let endFrameFile   = null;
let activeJobs = new Map();
let jobCounter = 0;
let lbMediaList = [], lbCurrentIndex = 0, lbCurrentType = 'image';

// ===================== AUTH =====================
const $loginModal = document.getElementById('login-modal');
function openLoginModal()  { $loginModal.classList.add('show'); }
function closeLoginModal() { $loginModal.classList.remove('show'); }
function setToken(t)   { document.cookie = "viralio_token="+t+"; domain=.viralio.ro; path=/; max-age=604800; Secure; SameSite=Lax"; }
function getToken()    { const m = document.cookie.match(/(?:^|; )viralio_token=([^;]*)/); return m?m[1]:null; }
function removeToken() { document.cookie = "viralio_token=; domain=.viralio.ro; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"; }

async function handleCredentialResponse(resp) {
    try {
        const r = await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:resp.credential})});
        const d = await r.json();
        if(d.token){ setToken(d.token); closeLoginModal(); updateUI(d.user); }
    } catch(e){ toast('Eroare conectare server.'); }
}

function updateUI(user) {
    document.getElementById('login-top-btn').style.display = 'none';
    document.getElementById('login-top-btn-mobile').style.display = 'none';
    const up = document.getElementById('user-profile');
    up.classList.remove('hidden'); up.style.display = 'flex';
    document.getElementById('nav-name').innerText = user.name.split(' ')[0];
    document.getElementById('nav-avatar').src = user.picture;
    document.getElementById('nav-credits').innerText = user.credits;
    loadHistory();
}

function logout() { removeToken(); location.reload(); }

window.onload = async () => {
    const savedMode = localStorage.getItem('viralio_mode');
    if (savedMode === 'video' && mode !== 'video') {
        mode = 'video';
        document.getElementById('tab-image').classList.remove('active');
        document.getElementById('tab-video').classList.add('active');
        document.getElementById('og-img').style.display = 'none';
        document.getElementById('og-vid').style.display = '';
        document.getElementById('og-grok').style.display = '';
        ddocument.getElementById('model-sel').value = 'grok-720p-6s';
        updateModelEtaChip();
        document.getElementById('img-options').classList.add('hidden');
        document.getElementById('vid-options').classList.remove('hidden');
        document.getElementById('refs-section').classList.add('hidden');
        refreshBadges();
    }

    const t = getToken();
    if(t) {
        try {
            const r = await fetch('/api/auth/me',{headers:{'Authorization':'Bearer '+t}});
            if(r.ok){ const d=await r.json(); updateUI(d.user); } else removeToken();
        } catch(e){}
    }
    refreshBadges();
    if(t) { tryRestoreTask(); }
};

// ===================== UI HELPERS =====================
function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2800); }
function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function updateCharCount(){ document.getElementById('char-count').textContent = document.getElementById('prompt-in').value.length + ' caractere'; }
function fillExample(){ document.getElementById('prompt-in').value='A cinematic wide shot of a futuristic cyberpunk city at sunset, neon lights reflecting on wet streets, 8k resolution, photorealistic'; updateCharCount(); }
function updateCount(d){ imgCount=Math.min(4,Math.max(1,imgCount+d)); document.getElementById('count-val').textContent=imgCount; refreshBadges(); }
function updateVCount(d){ vidCount=Math.min(4,Math.max(1,vidCount+d)); document.getElementById('vcount-val').textContent=vidCount; refreshBadges(); }

function refreshBadges(){
    const sel = document.getElementById('model-sel');
    const m = MODEL_META[sel?.value]||{type:'image',cost:1};
    const n = mode==='image'?imgCount:vidCount;
    document.getElementById('total-cost').textContent = m.cost*n;
}

function onModelChange(){ refreshBadges(); updateModelEtaChip(); }

function updateModelEtaChip(){
    const chip = document.getElementById('model-eta-chip');
    if(!chip) return;
    const modelId = document.getElementById('model-sel')?.value || '';
    if(modelId.startsWith('grok-')){
        chip.style.display = 'flex';
        chip.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;background:rgba(99,211,140,0.08);border:1px solid rgba(99,211,140,0.2);width:100%;box-sizing:border-box"><span style="font-size:0.95rem">${modelId==='grok-extend'?'🔗':'⚡'}</span><div><span style="font-size:0.68rem;font-weight:700;color:rgba(99,211,140,0.9);letter-spacing:0.02em">~40 secunde</span><span style="font-size:0.65rem;color:rgba(255,255,255,0.3);margin-left:6px">${modelId==='grok-extend'?'Grok Extend · continuă video':'procesare rapidă'}</span></div></div>`;
    } else if(modelId.startsWith('veo')){
        chip.style.display = 'flex';
        chip.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);width:100%;box-sizing:border-box"><span style="font-size:0.95rem">${modelId==='veo-extend'?'🔗':'⏳'}</span><div><span style="font-size:0.68rem;font-weight:700;color:rgba(167,139,250,0.9);letter-spacing:0.02em">1–2 minute</span><span style="font-size:0.65rem;color:rgba(255,255,255,0.3);margin-left:6px">${modelId==='veo-extend'?'Veo Extend · continuă video':'servere aglomerate'}</span></div></div>`;
    } else {
        chip.style.display = 'none';
        chip.innerHTML = '';
    }
}

function switchMode(m){
    mode=m; const isVid=m==='video';
    try { localStorage.setItem('viralio_mode', m); } catch(e) {}
    document.getElementById('tab-image').classList.toggle('active',!isVid);
    document.getElementById('tab-video').classList.toggle('active',isVid);
    document.getElementById('og-img').style.display = isVid?'none':'';
    document.getElementById('og-vid').style.display = isVid?'':'none';
    document.getElementById('og-grok').style.display = isVid?'':'none';
    document.getElementById('model-sel').value = isVid?'grok-720p-6s':'gemini-flash';
    updateModelEtaChip();
    document.getElementById('img-options').classList.toggle('hidden',isVid);
    document.getElementById('vid-options').classList.toggle('hidden',!isVid);
    document.getElementById('refs-section').classList.toggle('hidden', isVid);
    refreshBadges();
    if(getToken()) loadHistory();
}

function aspectClass(r){
    if(r==='16:9') return 'aspect-video';
    if(r==='9:16') return 'aspect-[9/16]';
    if(r==='21:9') return 'aspect-[21/9]';
    return 'aspect-square';
}

// ===================== START / END FRAME =====================
function handleFrameSelect(type, e) {
    const file = e.target.files[0]; if (!file) return;
    const url = URL.createObjectURL(file);
    if (type === 'start') {
        startFrameFile = file;
        document.getElementById('start-frame-img').src = url;
        document.getElementById('start-frame-preview').classList.remove('hidden');
        document.getElementById('start-frame-zone').classList.add('hidden');
    } else {
        endFrameFile = file;
        document.getElementById('end-frame-img').src = url;
        document.getElementById('end-frame-preview').classList.remove('hidden');
        document.getElementById('end-frame-zone').classList.add('hidden');
    }
    e.target.value = '';
}

function removeFrame(type) {
    if (type === 'start') {
        startFrameFile = null;
        document.getElementById('start-frame-img').src = '';
        document.getElementById('start-frame-preview').classList.add('hidden');
        document.getElementById('start-frame-zone').classList.remove('hidden');
    } else {
        endFrameFile = null;
        document.getElementById('end-frame-img').src = '';
        document.getElementById('end-frame-preview').classList.add('hidden');
        document.getElementById('end-frame-zone').classList.remove('hidden');
    }
}

// ===================== REFS =====================
function handleFileSelect(e){ Array.from(e.target.files).forEach(f=>{ if(uploadedRefs.length<4) uploadedRefs.push(f); }); renderRefGallery(); e.target.value=''; }
function removeRef(i,e){ e.stopPropagation(); uploadedRefs.splice(i,1); renderRefGallery(); }
function insertTag(i){ const ta=document.getElementById('prompt-in'); const tag=`@img${i+1}`; const s=ta.selectionStart; ta.value=ta.value.substring(0,s)+` ${tag} `+ta.value.substring(ta.selectionEnd); ta.focus(); updateCharCount(); }
function renderRefGallery(){
    const gal=document.getElementById('ref-gallery'); const zone=document.getElementById('ref-zone');
    if(uploadedRefs.length>0){ gal.classList.remove('hidden'); zone.classList.add('hidden'); }
    else { gal.classList.add('hidden'); zone.classList.remove('hidden'); }
    gal.innerHTML=uploadedRefs.map((f,i)=>{
        const url=window.URL.createObjectURL(f);
        return `<div class="relative w-[4.5rem] h-[4.5rem] rounded-xl overflow-hidden group cursor-pointer" style="border:1.5px solid rgba(99,102,241,0.3)" onclick="insertTag(${i})"><img src="${url}" class="w-full h-full object-cover"><span class="absolute top-1 left-1 text-white text-[0.52rem] font-bold px-1.5 py-0.5 rounded" style="background:rgba(99,102,241,0.8)">@img${i+1}</span><button onclick="removeRef(${i},event)" class="absolute top-1 right-1 w-5 h-5 bg-red-500/80 text-white rounded-full flex items-center justify-center text-[0.55rem] opacity-0 group-hover:opacity-100 transition-all"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('');
}

function handlePromptInput(){
    updateCharCount();
    const menu=document.getElementById('autocomplete-menu');
    if(uploadedRefs.length===0){ menu.classList.remove('show'); return; }
    const val=document.getElementById('prompt-in').value;
    const pos=document.getElementById('prompt-in').selectionStart;
    if(val.charAt(pos-1)==='@'){ showAutocomplete(); } else { menu.classList.remove('show'); }
}
function showAutocomplete(){
    const menu=document.getElementById('autocomplete-menu'); menu.innerHTML='';
    uploadedRefs.forEach((f,i)=>{
        const url=window.URL.createObjectURL(f);
        const item=document.createElement('div'); item.className='autocomplete-item';
        item.innerHTML=`<img src="${url}" class="w-8 h-8 rounded-lg object-cover border border-white/10"><span class="text-sm font-bold">@img${i+1}</span>`;
        item.onclick=(e)=>{ e.stopPropagation(); const ta=document.getElementById('prompt-in'); const pos=ta.selectionStart; ta.value=ta.value.substring(0,pos)+`img${i+1} `+ta.value.substring(pos); ta.focus(); updateCharCount(); menu.classList.remove('show'); };
        menu.appendChild(item);
    });
    menu.classList.add('show');
}
document.addEventListener('click',(e)=>{ const m=document.getElementById('autocomplete-menu'); if(m&&!m.contains(e.target)&&e.target!==document.getElementById('prompt-in')) m.classList.remove('show'); });

// ===================== LIGHTBOX =====================
function openLightbox(list, idx, type){
    lbMediaList=list; lbCurrentIndex=idx; lbCurrentType=type;
    updateLightboxContent();
    document.getElementById('lb-prev').classList.toggle('hidden',list.length<=1);
    document.getElementById('lb-next').classList.toggle('hidden',list.length<=1);
    document.getElementById('lightbox').classList.add('show');
}
function updateLightboxContent(){
    const img=document.getElementById('lb-img'); const vid=document.getElementById('lb-vid'); const dlBtn=document.getElementById('lb-download-btn');
    img.classList.add('hidden'); vid.classList.add('hidden');
    try { vid.pause(); } catch(e){}
    const item=lbMediaList[lbCurrentIndex];
    let url,type;
    if(item&&typeof item==='object'&&item.url){ url=item.url; type=item.type; } else { url=item; type=lbCurrentType; }
    dlBtn.onclick=(e)=>{ e.stopPropagation(); downloadMedia(url,`viralio_${Date.now()}.${type==='video'?'mp4':'png'}`); };
    if(type==='video'){ vid.src=url; vid.style.cssText='max-width:90vw;max-height:85vh;width:auto;height:auto;'; vid.classList.remove('hidden'); vid.load(); }
    else { img.src=url; img.classList.remove('hidden'); }
}
function navLightbox(dir,e){ if(e)e.stopPropagation(); lbCurrentIndex=(lbCurrentIndex+dir+lbMediaList.length)%lbMediaList.length; updateLightboxContent(); }
function closeLightbox(){ document.getElementById('lightbox').classList.remove('show'); setTimeout(()=>{ try{document.getElementById('lb-vid').pause();}catch(e){} },300); }
document.addEventListener('keydown',(e)=>{ if(!document.getElementById('lightbox').classList.contains('show')) return; if(e.key==='ArrowLeft'&&lbMediaList.length>1) navLightbox(-1,null); if(e.key==='ArrowRight'&&lbMediaList.length>1) navLightbox(1,null); if(e.key==='Escape') closeLightbox(); });

// ===================== DOWNLOAD =====================
async function downloadMedia(url, filename){
    try {
        const r = await fetch(url, { mode: 'cors' });
        if (!r.ok) throw new Error('fetch failed');
        const blob = await r.blob();
        const bu = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = bu; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        window.URL.revokeObjectURL(bu);
    } catch(err){
        const proxyUrl = `/api/media/proxy-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
        const a = document.createElement('a'); a.href = proxyUrl; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
}

// ===================== EMPTY STATE =====================
function checkEmptyState(){
    const jobs=document.getElementById('jobs-area');
    const empty=document.getElementById('st-empty');
    if(jobs.children.length===0){ empty.classList.remove('hidden'); } else { empty.classList.add('hidden'); }
}

// ===================== JOB SYSTEM =====================

function buildShimmerLoading(currentMode, count, ratio, modelId) {
    count = count || 1;
    ratio = ratio || '9:16';
    const ratioMap = {'9:16':'9/16','16:9':'16/9','1:1':'1/1','4:5':'4/5','5:4':'5/4','3:4':'3/4','4:3':'4/3','2:3':'2/3','3:2':'3/2','21:9':'21/9'};
    const aspectCSS = ratioMap[ratio] || '1/1';
    const isPortrait = ['9:16','4:5','3:4','2:3'].includes(ratio);
    const isLandscape = ['16:9','21:9','3:2','4:3','5:4'].includes(ratio);
    // Dimensiuni placeholder similare cu cardurile finale
    const cardW = isPortrait ? '140px' : isLandscape ? '220px' : '180px';
    // Grid wrapper similar cu setJobDone pentru consistență vizuală
    const maxW = count === 1
        ? (isPortrait ? '210px' : isLandscape ? '460px' : '280px')
        : (isPortrait ? (count<=2?'340px':count===3?'500px':'660px') : (isLandscape ? '100%' : (count<=2?'420px':'560px')));
    const gridCols = count === 1 ? '1fr'
        : (isPortrait ? `repeat(${Math.min(count,4)},1fr)` : (isLandscape ? 'repeat(2,1fr)' : `repeat(${Math.min(count,2)},1fr)`));

    // Fiecare placeholder are data-slot pentru înlocuire progresivă
    const placeholders = Array.from({length: count}, (_, i) =>
        `<div class="rounded-xl shimmer-box" data-slot="${i}" style="aspect-ratio:${aspectCSS};animation-delay:${i*0.15}s;transition:opacity 0.3s"></div>`
    ).join('');

    return `<div style="padding:12px"><div id="job-media-grid-JOBID" style="display:grid;grid-template-columns:${gridCols};gap:10px;max-width:${maxW};margin:0 auto">${placeholders}</div></div><p id="job-status-JOBID" style="display:none;"></p>`;
}

// ===================== PROGRESSIVE RENDER =====================
// Înlocuiește un shimmer placeholder cu media reală când vine partial_url
function renderPartialResult(jobId, url, uuid, slotIndex, totalCount, ratio, mediaType, allPartialUrls, allPartialUuids){
    const grid = document.getElementById(`job-media-grid-${jobId}`);
    if(!grid) return;
    const slot = grid.querySelector(`[data-slot="${slotIndex}"]`);
    if(!slot) return;

    const ratioMap = {'9:16':'9/16','16:9':'16/9','1:1':'1/1','4:5':'4/5','5:4':'5/4','3:4':'3/4','4:3':'4/3','2:3':'2/3','3:2':'3/2','21:9':'21/9'};
    const aspectCSS = ratioMap[ratio] || '1/1';
    const ts = Date.now() + slotIndex;

    const el = document.createElement('div');
    el.className = 'result-card';
    el.dataset.slot = slotIndex;
    el.style.cssText = 'border-radius:14px;overflow:hidden;animation:fadeInUp 0.4s cubic-bezier(0.16,1,0.3,1) forwards';

    if(mediaType === 'image'){
        const allStr = JSON.stringify(allPartialUrls);
        el.innerHTML = `<div class="${aspectClass(ratio)} w-full relative group overflow-hidden" style="border-radius:14px 14px 0 0"><img src="${url}" class="absolute inset-0 w-full h-full object-cover"><div class="card-overlay"><button onclick='openLightbox(${allStr},${slotIndex},"image")' class="text-white backdrop-blur-md text-xs font-bold px-3 py-1.5 rounded-xl transition-all hover:scale-105" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2)"><i class="fa-solid fa-expand mr-1"></i>Mărește</button></div></div><div class="p-2.5" style="border-top:1px solid rgba(255,255,255,0.05)"><button onclick="downloadMedia('${url}','viralio_img_${ts}.png')" class="w-full text-xs font-bold px-3 py-2 rounded-xl transition-all" style="color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07)"><i class="fa-solid fa-download mr-1"></i>Descarcă</button></div>`;
    } else {
        const extendAttr = uuid ? `data-uuid="${uuid}" data-url="${url}"` : `data-url="${url}"`;
        // ✅ Fix video: butoane pe un singur rând, fără text wrap, video vizibil
        el.innerHTML = `<div class="${aspectClass(ratio)} w-full relative overflow-hidden" style="background:#000;border-radius:14px 14px 0 0"><video src="${url}" controls playsinline preload="metadata" class="absolute inset-0 w-full h-full object-contain"></video></div><div class="p-2" style="border-top:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:6px"><button onclick="downloadMedia('${url}','viralio_vid_${ts}.mp4')" style="width:100%;font-size:0.72rem;font-weight:700;padding:6px 8px;border-radius:10px;color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i class="fa-solid fa-download" style="margin-right:4px"></i>Descarcă</button><button ${extendAttr} onclick="openExtendModal(this.dataset.uuid,this.dataset.url)" style="width:100%;font-size:0.72rem;font-weight:700;padding:6px 8px;border-radius:10px;color:rgba(165,168,255,0.9);background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i class="fa-solid fa-forward" style="font-size:0.6rem;margin-right:4px"></i>Extinde Video</button></div>`;
    }

    slot.replaceWith(el);
}

// ===================== ETA TIMER =====================
const _etaTimers = {};
function startEtaTimer(jobId, maxSec) {
    let elapsed = 0;
    const timerId = setInterval(() => {
        elapsed++;
        const timerEl = document.getElementById(`eta-timer-${jobId}`);
        const barEl   = document.getElementById(`eta-bar-${jobId}`);
        if (!timerEl) { clearInterval(timerId); return; }
        timerEl.textContent = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`;
        if (barEl) { barEl.style.width = Math.min((elapsed / maxSec) * 100, 97) + '%'; }
        if (elapsed >= maxSec * 3) clearInterval(timerId);
    }, 1000);
    _etaTimers[jobId] = timerId;
}
function stopEtaTimer(jobId) {
    if (_etaTimers[jobId]) {
        clearInterval(_etaTimers[jobId]);
        delete _etaTimers[jobId];
        const barEl = document.getElementById(`eta-bar-${jobId}`);
        if (barEl) { barEl.style.transition='width 0.4s ease'; barEl.style.width='100%'; }
    }
}

function createJobCard(jobId, promptText, currentMode, count, ratio){
    count = count || 1;
    ratio = ratio || '9:16';
    const el=document.createElement('div');
    el.id=`job-${jobId}`;
    el.className='job-card processing';
    const typeLabel = currentMode==='video'
        ? `<span class="flex items-center gap-1.5" style="color:rgba(165,168,255,0.7)"><i class="fa-solid fa-clapperboard text-[0.6rem]"></i> <span class="font-bold text-[0.65rem] uppercase tracking-wider">Video</span></span>`
        : `<span class="flex items-center gap-1.5" style="color:rgba(165,168,255,0.7)"><i class="fa-solid fa-image text-[0.6rem]"></i> <span class="font-bold text-[0.65rem] uppercase tracking-wider">Imagine</span></span>`;
    const _selModel = document.getElementById('model-sel')?.value || '';
    const shimmer = buildShimmerLoading(currentMode, count, ratio, _selModel).replace(/JOBID/g, String(jobId));
    el.innerHTML=`<div class="flex items-center justify-between px-5 py-3.5" style="border-bottom:1px solid rgba(255,255,255,0.05)"><div class="flex items-center gap-3 overflow-hidden flex-1 min-w-0"><div class="pulse-ring shrink-0"><div class="w-2.5 h-2.5 rounded-full" style="background:rgba(99,102,241,0.9)"></div></div><span class="text-sm font-medium truncate" style="color:rgba(255,255,255,0.6);max-width:240px">${escHtml(promptText)}</span></div><div class="shrink-0 ml-3 flex items-center gap-2">${typeLabel}</div></div><div id="job-body-${jobId}" class="p-4">${shimmer}</div>`;
    return el;
}

function setJobStatus(jobId, text){
    const el = document.getElementById(`job-status-${jobId}`);
    if(el){ el.textContent = text; return; }
    const body = document.getElementById(`job-body-${jobId}`);
    if(!body) return;
    let st = body.querySelector('[data-status]');
    if(!st){ st = body.querySelector('p'); if(st) st.setAttribute('data-status','1'); }
    if(st) st.textContent = text;
}

function _addCloseBtn(card){
    const header = card.querySelector('div[style*="border-bottom"]');
    if(header && !header.querySelector('.job-close-btn')){
        const xBtn = document.createElement('button');
        xBtn.className='job-close-btn shrink-0 ml-2 w-6 h-6 rounded-lg flex items-center justify-center transition-all hover:scale-110';
        xBtn.style.cssText='background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.35)';
        xBtn.innerHTML='<i class="fa-solid fa-xmark text-[0.6rem]"></i>';
        xBtn.onclick=()=>{ card.style.transition='opacity 0.3s,transform 0.3s'; card.style.opacity='0'; card.style.transform='scale(0.97)'; setTimeout(()=>{ card.remove(); checkEmptyState(); },300); };
        header.appendChild(xBtn);
    }
}

function setJobDone(jobId, urls, ratioVal, currentMode, uuids){ stopEtaTimer(jobId); clearActiveTask();
    const body=document.getElementById(`job-body-${jobId}`); const card=document.getElementById(`job-${jobId}`);
    if(!body||!card) return;
    card.className='job-card done';
    _addCloseBtn(card);

    const pulseWrap = card.querySelector('.pulse-ring');
    if(pulseWrap){ pulseWrap.classList.remove('pulse-ring'); const dot = pulseWrap.querySelector('div') || pulseWrap; dot.style.background = 'rgba(52,211,153,0.9)'; }

    const isPortrait=['9:16','2:3','3:4','4:5'].includes(ratioVal);
    const isLandscape=['16:9','21:9','3:2','4:3','5:4'].includes(ratioVal);
    const count=urls.length;

    // ✅ Dacă media a fost deja randată progresiv, înlocuim doar shimmer-ele rămase
    const existingGrid = document.getElementById(`job-media-grid-${jobId}`);
    if(existingGrid){
        urls.forEach((url, idx) => {
            // Verificăm dacă slotul a fost deja înlocuit cu media reală
            const slot = existingGrid.querySelector(`[data-slot="${idx}"]`);
            if(slot && slot.classList.contains('shimmer-box')){
                // Slotul e încă shimmer — îl înlocuim
                renderPartialResult(jobId, url, (uuids&&uuids[idx])||'', idx, count, ratioVal, currentMode, urls, uuids||[]);
            }
        });
        // Eliminăm shimmer-ele rămase care nu au primit URL (erori parțiale)
        existingGrid.querySelectorAll('.shimmer-box').forEach(el => el.remove());
        // Actualizăm lightbox-ul pentru imagini (URL-urile complete sunt acum disponibile)
        if(currentMode==='image'){
            const allStr=JSON.stringify(urls);
            existingGrid.querySelectorAll('.result-card img').forEach((img,idx)=>{
                const btn = img.closest('.result-card')?.querySelector('button[onclick*="openLightbox"]');
                if(btn) btn.setAttribute('onclick', `openLightbox(${allStr},${idx},"image")`);
            });
        }
        return;
    }

const makeCard=(url, idx)=>{
        const el=document.createElement('div');
        el.className='result-card';
        const ts=Date.now()+idx;
        if(currentMode==='image'){
            const allStr=JSON.stringify(urls);
            el.innerHTML=`<div class="${aspectClass(ratioVal)} w-full relative group overflow-hidden" style="border-radius:14px 14px 0 0"><img src="${url}" class="absolute inset-0 w-full h-full object-cover"><div class="card-overlay"><button onclick='openLightbox(${allStr},${idx},"image")' class="text-white backdrop-blur-md text-xs font-bold px-3 py-1.5 rounded-xl transition-all hover:scale-105" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2)"><i class="fa-solid fa-expand mr-1"></i>Mărește</button></div></div><div class="p-2.5" style="border-top:1px solid rgba(255,255,255,0.05)"><button onclick="downloadMedia('${url}','viralio_img_${ts}.png')" class="w-full text-xs font-bold px-3 py-2 rounded-xl transition-all" style="color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07)"><i class="fa-solid fa-download mr-1"></i>Descarcă</button></div>`;
        } else {
            const uuid = (uuids && uuids[idx]) || '';
            const extendAttr = uuid ? `data-uuid="${uuid}" data-url="${url}"` : `data-url="${url}"`;
            // ✅ Fix: butoane compacte, fără text wrap, video vizibil
            el.innerHTML=`<div class="${aspectClass(ratioVal)} w-full relative overflow-hidden" style="background:#000;border-radius:14px 14px 0 0"><video src="${url}" controls playsinline preload="metadata" class="absolute inset-0 w-full h-full object-contain"></video></div><div class="p-2" style="border-top:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:6px"><button onclick="downloadMedia('${url}','viralio_vid_${ts}.mp4')" style="width:100%;font-size:0.72rem;font-weight:700;padding:6px 8px;border-radius:10px;color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i class="fa-solid fa-download" style="margin-right:4px"></i>Descarcă</button><button ${extendAttr} onclick="openExtendModal(this.dataset.uuid,this.dataset.url)" style="width:100%;font-size:0.72rem;font-weight:700;padding:6px 8px;border-radius:10px;color:rgba(165,168,255,0.9);background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i class="fa-solid fa-forward" style="font-size:0.6rem;margin-right:4px"></i>Extinde Video</button></div>`;
        }
        return el;
    };

    body.innerHTML='';
    const wrapper=document.createElement('div');
    wrapper.style.padding='12px';
    if(count===1){
        const maxW = isPortrait ? '210px' : isLandscape ? '460px' : '280px';
        wrapper.style.maxWidth=maxW; wrapper.style.margin='0 auto';
        wrapper.appendChild(makeCard(urls[0],0));
    } else {
        const grid=document.createElement('div'); grid.style.display='grid'; grid.style.gap='10px';
        if(isPortrait){ const cols=Math.min(count,4); grid.style.gridTemplateColumns=`repeat(${cols},1fr)`; grid.style.maxWidth=count<=2?'340px':count===3?'460px':'580px'; grid.style.margin='0 auto'; }
        else if(isLandscape){ grid.style.gridTemplateColumns='repeat(2,1fr)'; }
        else { grid.style.gridTemplateColumns=`repeat(${Math.min(count,2)},1fr)`; grid.style.maxWidth=count<=2?'420px':'560px'; grid.style.margin='0 auto'; }
        urls.forEach((url,i)=>grid.appendChild(makeCard(url,i)));
        wrapper.appendChild(grid);
    }
    body.appendChild(wrapper);
}

function setJobError(jobId, msg){ stopEtaTimer(jobId); 
    // Dacă eroarea este din cauza refresh-ului, NU ștergem task-ul din local storage,
    // lăsând funcția tryRestoreTask() să repornească interfața!
    if (!msg.includes('Conexiunea a fost întreruptă')) {
        clearActiveTask(); 
    }
    
    const body=document.getElementById(`job-body-${jobId}`); const card=document.getElementById(`job-${jobId}`);
    if(!body) return;
    card.className='job-card error';
    _addCloseBtn(card);
    const pulseWrap = card.querySelector('.pulse-ring');
    if(pulseWrap){ pulseWrap.classList.remove('pulse-ring'); const dot = pulseWrap.querySelector('div') || pulseWrap; dot.style.background = 'rgba(248,113,113,0.9)'; }
    const isBlocked = msg && (
        msg.includes('\uD83D\uDEAB') || msg.includes('blocat') || msg.includes('filtrat') ||
        msg.includes('inadecvat') || msg.includes('siguranță') || msg.includes('Audio') ||
        msg.includes('politicile') || msg.includes('content moderation') ||
        msg.includes('minori') || msg.includes('referință')
    );
    const icon = isBlocked ? 'fa-ban' : 'fa-triangle-exclamation';
    const iconColor = isBlocked ? 'rgba(251,146,60,0.8)' : 'rgba(248,113,113,0.8)';
    // Renderăm newline-urile ca <br> pentru mesaje multi-linie
    const formattedMsg = escHtml(msg).replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
    const actionBtn = isBlocked
        ? `<button onclick="document.getElementById('prompt-in').focus();" class="text-xs font-bold px-4 py-2 rounded-xl mt-1 transition-all hover:scale-105" style="color:rgba(251,146,60,0.9);background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.2)">✏️ Modifică promptul</button>`
        : '';
    body.innerHTML=`<div class="flex flex-col items-center gap-2 py-4 px-3 w-full"><i class="fa-solid ${icon} text-2xl" style="color:${iconColor}"></i><p class="text-xs text-left leading-relaxed" style="color:rgba(255,255,255,0.45);max-width:340px">${formattedMsg}</p>${actionBtn}</div>`;
}

function _addCloseBtn(card){
    const header = card.querySelector('div[style*="border-bottom"]');
    if(header && !header.querySelector('.job-close-btn')){
        const xBtn = document.createElement('button');
        xBtn.className='job-close-btn shrink-0 ml-2 w-6 h-6 rounded-lg flex items-center justify-center transition-all hover:scale-110';
        xBtn.style.cssText='background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.35)';
        xBtn.innerHTML='<i class="fa-solid fa-xmark text-[0.6rem]"></i>';
        xBtn.onclick=()=>{ 
            clearActiveTask(); // Acum trebuie șters manual doar dacă utilizatorul închide explicit cardul de eroare
            card.style.transition='opacity 0.3s,transform 0.3s'; card.style.opacity='0'; card.style.transform='scale(0.97)'; 
            setTimeout(()=>{ card.remove(); checkEmptyState(); },300); 
        };
        header.appendChild(xBtn);
    }
}

// ===================== SSE READER =====================
async function readSSEJob(jobId, response, opts={}){
    const { currentMode, ratio, count } = opts;
    const reader=response.body.getReader();
    const dec=new TextDecoder(); let buf=''; let finalData={}; let lastError=null;
    // State pentru afișare progresivă
    const partialUrls=[]; const partialUuids=[];
    try {
        while(true){
            const {done,value}=await reader.read();
            if(value) buf+=dec.decode(value,{stream:true});
            if(done){ if(buf.trim()) buf+='\n'; }
            const lines=buf.split('\n'); buf=lines.pop();
            for(const line of lines){
                const t=line.trim(); if(!t||t.startsWith(':')) continue;
                if(t.startsWith('data:')){
                    const raw=t.slice(5).trim();
                    if(raw==='[DONE]') continue;
                    if(raw.startsWith('{')||raw.startsWith('[')){
                        try {
                            const p=JSON.parse(raw);
                            if(p.error){ lastError=p.error; continue; }
                            // ✅ Afișare progresivă: fiecare media gata vine separat
                            if(p.partial_url){
                                partialUrls.push(p.partial_url);
                                partialUuids.push(p.partial_uuid||'');
                                const mediaType = p.partial_type || currentMode || 'image';
                                if(p.status) setJobStatus(jobId, p.status);
                                renderPartialResult(jobId, p.partial_url, p.partial_uuid||'', partialUrls.length-1, count||1, ratio, mediaType, partialUrls, partialUuids);
                                continue;
                            }
                            if(p.status&&Object.keys(p).length===1){ setJobStatus(jobId,p.status); continue; }
                            if(p.status&&!p.file_urls&&!p.file_url&&!p.video_url&&!p.url&&!p.partial_url){ setJobStatus(jobId,p.status); continue; }
                            Object.assign(finalData,p);
                        } catch(e){}
                    }
                }
            }
            if(done) break;
        }
    } finally {}
    if(lastError&&!finalData.file_urls&&!finalData.file_url&&!finalData.video_url&&!finalData.url&&partialUrls.length===0) throw new Error(lastError);
    if(!lastError && Object.keys(finalData).length===0){
        if(partialUrls.length>0) return { file_urls: partialUrls, file_uuids: partialUuids, saved_to_history: true };
        throw new Error('Conexiunea a fost întreruptă. Reîncearcă.');
    }
    const result = Object.keys(finalData).length>0 ? finalData : null;
    if(result && !result.file_urls && partialUrls.length>0) result.file_urls = partialUrls;
    if(result && !result.file_uuids && partialUuids.length>0) result.file_uuids = partialUuids;
    return result;
}

function extractUrls(data){
    if(!data) return { urls: [], uuids: [] };
    const uuids = data.file_uuids || [];
    if(data.file_urls&&Array.isArray(data.file_urls)&&data.file_urls.length>0) return { urls: data.file_urls, uuids };
    if(data.file_url) return { urls: [data.file_url], uuids };
    if(data.video_url) return { urls: [data.video_url], uuids };
    if(data.url) return { urls: [data.url], uuids };
    const found=[]; const scan=(o)=>{ for(let k in o){ if(typeof o[k]==='string'&&(o[k].includes('.mp4')||o[k].includes('.png')||o[k].startsWith('http'))) found.push(o[k]); else if(typeof o[k]==='object'&&o[k]!==null) scan(o[k]); } }; scan(data);
    return { urls: found, uuids };
}

// ===================== RUN JOB =====================
async function runJob(jobId, promptText, currentMode, ratio, refs, token, startFrame, endFrame){
    const job=activeJobs.get(jobId); if(!job) return;
    try {
        const fd=new FormData();
        if(currentMode==='image'){
            const model_id=document.getElementById('model-sel').value;
            setJobStatus(jobId,'Se generează imaginile...');
            fd.append('prompt',promptText); fd.append('aspect_ratio',ratio); fd.append('number_of_images',imgCount); fd.append('model_id',model_id);
            refs.forEach(f=>fd.append('ref_images',f,f.name));
            const resp=await fetch('/api/media/image',{method:'POST',headers:{'Authorization':'Bearer '+token},body:fd});
            if(!resp.ok){ const j=await resp.json().catch(()=>{}); throw new Error(j?.error||'Eroare server'); }
            const data=await readSSEJob(jobId,resp,{currentMode,ratio,count:imgCount});
            const { urls } = extractUrls(data); if(!urls?.length) throw new Error('Nu s-au generat imagini.');
            setJobDone(jobId,urls,ratio,currentMode,[]);
            if(!data?.saved_to_history) await saveToSupabase(urls,promptText,currentMode,[]);
        } else {
            const model_id=document.getElementById('model-sel').value;
            let statusMsg = 'Se trimite la AI...';
            if (startFrame && endFrame) statusMsg = 'Se trimite cu start + end frame...';
            else if (startFrame) statusMsg = 'Se trimite cu start frame...';
            else if (model_id === 'veo-extend' || model_id === 'grok-extend') statusMsg = 'Se trimite pentru extend video...';
            setJobStatus(jobId, statusMsg);
            fd.append('prompt',promptText); fd.append('aspect_ratio',ratio); fd.append('number_of_videos',vidCount); fd.append('model_id',model_id);
            if (startFrame) fd.append('start_image', startFrame, startFrame.name);
            if (endFrame)   fd.append('end_image',   endFrame,   endFrame.name);
            refs.forEach(f=>fd.append('ref_images',f,f.name));
            const resp=await fetch('/api/media/video',{method:'POST',headers:{'Authorization':'Bearer '+token},body:fd});
            if(!resp.ok){ const j=await resp.json().catch(()=>{}); throw new Error(j?.error||'Eroare server'); }
            const data=await readSSEJob(jobId,resp,{currentMode,ratio,count:vidCount});
            const { urls, uuids } = extractUrls(data); if(!urls?.length) throw new Error('Nu s-a generat video.');
            setJobDone(jobId,urls,ratio,currentMode,uuids);
            if(!data?.saved_to_history) await saveToSupabase(urls,promptText,currentMode,uuids);
        }
        setTimeout(loadHistory, 3000);
    } catch(err){
        let msg = err.message || '';
        if (msg === 'Failed to fetch' || msg === 'NetworkError when attempting to fetch resource.' || msg.toLowerCase().includes('network') || msg === 'Load failed') {
            msg = 'Conexiunea a fost întreruptă. Verifică internetul și reîncearcă.';
        } else if (msg === 'Nu s-a generat video.' || msg === 'Nu s-au generat imagini.') {
            msg = 'Nu s-a putut genera conținut. Reîncearcă sau modifică promptul.';
        }
        setJobError(jobId, msg);
    } finally {
        activeJobs.delete(jobId);
        try { const r=await fetch('/api/auth/me',{headers:{'Authorization':'Bearer '+token}}); if(r.ok){ const d=await r.json(); document.getElementById('nav-credits').innerText=d.user.credits; } } catch(e){}
    }
}

// ===================== EXTEND MODAL =====================
let _extendUUID = '';
let _extendUrl  = '';
let _extendModel = 'grok';
let _extendDuration = 10;

function openExtendModal(uuid, url) {
    _extendUUID = uuid || ''; _extendUrl = url || '';
    _extendModel = 'grok'; _extendDuration = 10;
    try { localStorage.setItem('viralio_last_extend', JSON.stringify({ uuid, url, ts: Date.now() })); } catch(e){}
    const vid = document.getElementById('ext-preview-vid');
    if(vid) { vid.src = url; vid.currentTime = 0; }
    const pr = document.getElementById('ext-prompt'); if(pr) pr.value = '';
    selectExtendModel('grok'); selectExtendDuration(10);
    const modal = document.getElementById('extend-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => { modal.style.opacity = '1'; });
}

function closeExtendModal(e) {
    if(e && e.target !== document.getElementById('extend-modal') && e.type !== 'click') return;
    const modal = document.getElementById('extend-modal');
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    const vid = document.getElementById('ext-preview-vid');
    if(vid) { vid.pause(); vid.src = ''; }
}

function selectExtendModel(model) {
    _extendModel = model;
    const grokBtn = document.getElementById('ext-btn-grok');
    const veoBtn  = document.getElementById('ext-btn-veo');
    const durRow  = document.getElementById('ext-duration-row');
    if(model === 'grok') {
        grokBtn.style.border='1.5px solid rgba(99,102,241,0.5)'; grokBtn.style.background='rgba(99,102,241,0.12)'; grokBtn.querySelector('div div:first-child').style.color='rgba(165,168,255,0.95)';
        veoBtn.style.border='1.5px solid rgba(255,255,255,0.08)'; veoBtn.style.background='rgba(255,255,255,0.03)'; veoBtn.querySelector('div div:first-child').style.color='rgba(255,255,255,0.7)';
        if(durRow) durRow.style.display = 'block';
    } else {
        veoBtn.style.border='1.5px solid rgba(99,102,241,0.5)'; veoBtn.style.background='rgba(99,102,241,0.12)'; veoBtn.querySelector('div div:first-child').style.color='rgba(165,168,255,0.95)';
        grokBtn.style.border='1.5px solid rgba(255,255,255,0.08)'; grokBtn.style.background='rgba(255,255,255,0.03)'; grokBtn.querySelector('div div:first-child').style.color='rgba(255,255,255,0.7)';
        if(durRow) durRow.style.display = 'none';
    }
}

function selectExtendDuration(dur) {
    _extendDuration = dur;
    const b6=document.getElementById('ext-dur-6'), b10=document.getElementById('ext-dur-10');
    const active={border:'1.5px solid rgba(99,102,241,0.5)',background:'rgba(99,102,241,0.12)',color:'rgba(165,168,255,0.95)'};
    const inactive={border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.03)',color:'rgba(255,255,255,0.5)'};
    Object.assign(b6.style, dur===6?active:inactive);
    Object.assign(b10.style, dur===10?active:inactive);
}

async function submitExtend() {
    const token = getToken(); if(!token){ closeExtendModal(); openLoginModal(); return; }
    if(!_extendUUID){ toast('UUID lipsă — videoclipul nu are ID salvat.'); return; }
    const prompt = document.getElementById('ext-prompt')?.value?.trim() || '';
    const model_id = _extendModel === 'grok' ? 'grok-extend' : 'veo-extend';
    const ratio = '9:16';
    closeExtendModal();
    const jobId = ++jobCounter;
    activeJobs.set(jobId, { aborted: false, reader: null });
    const card = createJobCard(jobId, prompt || 'Extend video...', 'video', 1, ratio);
    document.getElementById('jobs-area').prepend(card);
    checkEmptyState();
    const maxSec = _extendModel === 'grok' ? 50 : 130;
    startEtaTimer(jobId, maxSec);
    markTaskActive(jobId, { type: 'extend', prompt, uuid: _extendUUID, model: model_id, ratio: '16:9', count: 1 });
    try {
        const fd = new FormData();
        fd.append('prompt', prompt); fd.append('model_id', model_id); fd.append('aspect_ratio', ratio);
        fd.append('number_of_videos', '1'); fd.append('ref_history', _extendUUID); fd.append('extend_duration', String(_extendDuration));
        setJobStatus(jobId, 'Se trimite la AI pentru extend...');
        const resp = await fetch('/api/media/video', { method:'POST', headers:{'Authorization':'Bearer '+token}, body:fd });
        if(!resp.ok){ const j = await resp.json().catch(()=>{}); throw new Error(j?.error||'Eroare server'); }
        const data = await readSSEJob(jobId, resp, {currentMode:'video', ratio, count:1});
        const { urls, uuids } = extractUrls(data);
        if(!urls?.length) throw new Error('Nu s-a generat video extend.');
        setJobDone(jobId, urls, ratio, 'video', uuids);
        if(!data?.saved_to_history) saveToSupabase(urls, prompt || 'Extend video', 'video', uuids);
        setTimeout(loadHistory, 2000);
    } catch(err) {
        let msg = err.message || '';
        if(msg === 'Failed to fetch' || msg.toLowerCase().includes('network')) msg = 'Conexiunea a fost întreruptă. Reîncearcă.';
        setJobError(jobId, msg);
    } finally {
        activeJobs.delete(jobId);
        try { const r = await fetch('/api/auth/me', { headers:{'Authorization':'Bearer '+token} }); if(r.ok){ const d = await r.json(); document.getElementById('nav-credits').innerText = d.user.credits; } } catch(e){}
    }
}

document.addEventListener('keydown', e => { if(e.key==='Escape' && document.getElementById('extend-modal').style.display==='flex') closeExtendModal(); });

// ===================== GENERATE =====================
async function generate(){
    const token=getToken(); if(!token){ openLoginModal(); return; }
    const promptText=document.getElementById('prompt-in').value.trim();
    if(!promptText){ toast('Introdu un prompt descriptiv!'); return; }
    const currentMode=mode;
    const ratio=currentMode==='image'?(document.querySelector('input[name="ratio"]:checked')?.value||'9:16'):(document.querySelector('input[name="vratio"]:checked')?.value||'16:9');
    const refs=[...uploadedRefs];
    const startFrame = currentMode==='video' ? startFrameFile : null;
    const endFrame   = currentMode==='video' ? endFrameFile   : null;
    const jobId=++jobCounter;
    activeJobs.set(jobId,{aborted:false,reader:null});
    const count = currentMode==='image' ? imgCount : vidCount;
    const card=createJobCard(jobId,promptText,currentMode,count,ratio);
    document.getElementById('jobs-area').prepend(card);
    checkEmptyState();
    if(window.innerWidth<768){
        const sidebar=document.getElementById('sidebar-settings');
        if(sidebar&&!sidebar.classList.contains('translate-y-full')) toggleMobileSettings();
    }
    runJob(jobId,promptText,currentMode,ratio,refs,token,startFrame,endFrame);
    if(currentMode==='video'){
        const modelId = document.getElementById('model-sel')?.value || '';
        const maxSec = (modelId.startsWith('grok-')) ? 50 : 130;
        startEtaTimer(jobId, maxSec);
        markTaskActive(jobId, { type: 'video', prompt: promptText, model: modelId, ratio, count: vidCount });
    } else {
        markTaskActive(jobId, { type: 'image', prompt: promptText, ratio, count: imgCount });
    }
}

// ===================== TASK PERSISTENCE =====================
const TASK_KEY = 'viralio_active_task';
const TASK_MAX_AGE = 15 * 60 * 1000;

function markTaskActive(jobId, meta) {
    try { localStorage.setItem(TASK_KEY, JSON.stringify({ jobId, startedAt: Date.now(), ...meta })); } catch(e) {}
}

function clearActiveTask() {
    try { localStorage.removeItem(TASK_KEY); } catch(e) {}
}

// ★ FIX BUG 2: restore model info so ETA badge renders correctly on refresh
function tryRestoreTask() {
    let task;
    try { const raw = localStorage.getItem(TASK_KEY); if (!raw) return; task = JSON.parse(raw); } catch(e) { clearActiveTask(); return; }
    const age = Date.now() - task.startedAt;
    if (age > TASK_MAX_AGE) { clearActiveTask(); return; }

    const restoredMode = (task.type === 'image') ? 'image' : 'video';
    const restoredRatio = task.ratio || (restoredMode === 'image' ? '9:16' : '16:9');
    const restoredCount = task.count || 1;
    const restoredPrompt = task.prompt || '…';
    const restoredModel = task.model || '';

    // ★ FIX: temporarily set model-sel to task.model so buildShimmerLoading picks up correct ETA
    const modelSel = document.getElementById('model-sel');
    const prevModel = modelSel?.value;
    if (restoredModel && modelSel) {
        // Ensure the option exists before setting
        const opt = modelSel.querySelector(`option[value="${restoredModel}"]`);
        if (opt) modelSel.value = restoredModel;
    }

    const restoredJobId = ++jobCounter;
    activeJobs.set(restoredJobId, { aborted: false, reader: null, restored: true });

    const card = createJobCard(restoredJobId, restoredPrompt, restoredMode, restoredCount, restoredRatio);
    const jobsArea = document.getElementById('jobs-area');
    if (jobsArea) { jobsArea.prepend(card); checkEmptyState(); }

    // Restore previous model selection
    if (prevModel && modelSel) modelSel.value = prevModel;

    setJobStatus(restoredJobId, 'Se recuperează generarea după refresh…');

    if (restoredMode === 'video' || task.type === 'extend') {
        const elapsed = Math.floor(age / 1000);
        const maxSec = (restoredModel || '').startsWith('grok') ? 50 : 130;
        startEtaTimer(restoredJobId, Math.max(maxSec - elapsed, 5));
    }

    _pollForResult(restoredJobId, restoredMode, restoredRatio, restoredPrompt, task.startedAt);
}

async function _pollForResult(jobId, jobMode, ratio, prompt, startedAt) {
    const token = getToken();
    if (!token) { setJobError(jobId, 'Sesiune expirată după refresh. Regenerează.'); clearActiveTask(); activeJobs.delete(jobId); return; }

    const MAX_POLLS = 120;
    const INTERVAL  = 5000;

    for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, INTERVAL));
        const job = activeJobs.get(jobId);
        if (!job) return;
        try {
            const res = await fetch(`/api/media/history?type=${jobMode === 'extend' ? 'video' : jobMode}&page=1&limit=20`, {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (!res.ok) continue;
            const data = await res.json();
            const found = (data.history || []).find(item => {
                const itemTs = new Date(item.createdAt).getTime();
                // Căutăm videoclipuri create DUPĂ momentul start-ului taskului (cu 3s toleranță pentru clock skew)
                return itemTs >= startedAt - 3000;
            });
            if (found) {
                const batchItems = (data.history || []).filter(item => {
                    const ts = new Date(item.createdAt).getTime();
                    return ts >= startedAt - 3000 && (item.prompt || '') === (found.prompt || '');
                });
                const urls  = batchItems.map(i => i.supabaseUrl || i.originalUrl).filter(Boolean);
                const uuids = batchItems.map(i => i.uuid || '');
                setJobDone(jobId, urls.length ? urls : [found.supabaseUrl || found.originalUrl], ratio, jobMode === 'extend' ? 'video' : jobMode, uuids);
                clearActiveTask(); setTimeout(loadHistory, 1000); activeJobs.delete(jobId);
                return;
            }
        } catch(e) {}
    }
    setJobError(jobId, 'Generarea a durat prea mult sau a eșuat. Verifică istoricul.');
    clearActiveTask(); activeJobs.delete(jobId);
}

// ===================== THEME TOGGLE =====================
function toggleTheme(){
    const html = document.documentElement;
    const isLight = html.classList.toggle('light');
    localStorage.setItem('viralio-theme', isLight ? 'light' : 'dark');
}
(function(){ const saved = localStorage.getItem('viralio-theme'); if(saved === 'light') document.documentElement.classList.add('light'); })();

// ===================== MOBILE SIDEBAR =====================
function toggleMobileSettings(){
    const sidebar=document.getElementById('sidebar-settings');
    const overlay=document.getElementById('mobile-overlay');
    const btn=document.getElementById('mobile-settings-btn');
    const sup=document.getElementById('support-buttons');
    if(sidebar.classList.contains('translate-y-full')){
        sidebar.classList.remove('translate-y-full'); overlay.classList.remove('opacity-0','pointer-events-none');
        btn.classList.add('translate-y-24','opacity-0'); if(sup) sup.classList.add('opacity-0','pointer-events-none');
    } else {
        sidebar.classList.add('translate-y-full'); overlay.classList.add('opacity-0','pointer-events-none');
        btn.classList.remove('translate-y-24','opacity-0'); if(sup) sup.classList.remove('opacity-0','pointer-events-none');
    }
}

// ===================== AUTO-REFRESH LA DEPLOY NOU =====================
(function(){
    let knownVersion = null;
    const CHECK_INTERVAL = 5 * 60 * 1000;
    async function checkVersion(){
        try {
            const res = await fetch('/api/version', { cache: 'no-store' });
            if(!res.ok) return;
            const { version } = await res.json();
            if(knownVersion === null){ knownVersion = version; return; }
            if(version !== knownVersion){
                const areJobsActive = activeJobs && activeJobs.size > 0;
                if(!areJobsActive){ location.reload(); } else { setTimeout(checkVersion, 30000); }
            }
        } catch(e){}
    }
    setTimeout(() => { checkVersion(); setInterval(checkVersion, CHECK_INTERVAL); }, 10000);
})();