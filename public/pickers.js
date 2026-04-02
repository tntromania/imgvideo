// ===================== EXTEND RECOVER AFTER REFRESH =====================
(function(){
    try {
        const saved = localStorage.getItem('viralio_last_extend');
        if(!saved) return;
        const data = JSON.parse(saved);
        if(!data || !data.url) return;
        if(Date.now() - data.ts > 2 * 60 * 60 * 1000) { localStorage.removeItem('viralio_last_extend'); return; }
        const bar = document.getElementById('extend-recover-bar');
        if(!bar) return;
        bar.style.display = 'block';
        requestAnimationFrame(() => { bar.style.opacity = '1'; bar.style.transform = 'translateX(-50%) translateY(0)'; });
        document.getElementById('extend-recover-btn').onclick = () => { dismissExtendRecover(); openExtendModal(data.uuid, data.url); };
        setTimeout(dismissExtendRecover, 10000);
    } catch(e){}
})();

function dismissExtendRecover(){
    const bar = document.getElementById('extend-recover-bar');
    if(!bar) return;
    bar.style.opacity = '0'; bar.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => { bar.style.display = 'none'; }, 400);
}

// ===================== REFS PICKER MODAL =====================
let _refsPickerSelected = [];

function openRefsPicker() {
    _refsPickerSelected = [...uploadedRefs.map(f => ({ type:'upload', file:f, url: URL.createObjectURL(f) }))];
    renderRefsPickerSelected();
    const modal = document.getElementById('refs-picker-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => { modal.style.opacity = '1'; });
    loadRefsPickerHistory();
}

function closeRefsPicker(e) {
    if(e && e.target !== document.getElementById('refs-picker-modal')) return;
    const modal = document.getElementById('refs-picker-modal');
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 300);
}

async function loadRefsPickerHistory() {
    const grid = document.getElementById('refs-picker-history-grid');
    const token = getToken();
    if(!token) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-lock mb-2 text-lg block" style="color:rgba(255,255,255,0.15)"></i>Conectează-te pentru istoric</div>`;
        return;
    }
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin mb-2 text-lg block" style="color:rgba(99,102,241,0.4)"></i>Se încarcă...</div>`;
    try {
        const currentModeLocal = mode;
        const res = await fetch(`/api/media/history?type=${currentModeLocal}&page=1&limit=40`, { headers:{'Authorization':'Bearer '+token} });
        const data = await res.json();
        const allItems = [];
        (data.history||[]).forEach(item => { const u = item.supabaseUrl||item.originalUrl; if(u) allItems.push({ url: u, type: item.type || currentModeLocal }); });

        if(!allItems.length) {
            grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-photo-film mb-2 text-xl block" style="color:rgba(255,255,255,0.1)"></i>Nicio înregistrare în istoric</div>`;
            return;
        }

        grid.innerHTML = allItems.map(({ url, type }) => {
            const isSelected = _refsPickerSelected.some(s => s.url === url);
            const isVideo = type === 'video';
            const mediaEl = isVideo
                ? `<video src="${url}" preload="none" muted playsinline style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'"></video><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3)"><div style="width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center"><i class="fa-solid fa-play" style="font-size:0.5rem;color:white;margin-left:1px"></i></div></div>`
                : `<img src="${url}" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'">`;
            return `<div class="refs-picker-item" data-url="${escHtml(url)}" onclick="toggleRefsPickerItem(this,'${escHtml(url)}')" style="aspect-ratio:1;border-radius:12px;overflow:hidden;cursor:pointer;position:relative;border:2px solid ${isSelected?'rgba(99,102,241,0.7)':'transparent'};transition:all 0.18s;background:#0a0a16">${mediaEl}<div class="refs-picker-check" style="position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;background:${isSelected?'rgba(99,102,241,0.95)':'rgba(0,0,0,0.4)'};border:2px solid ${isSelected?'rgba(165,168,255,0.8)':'rgba(255,255,255,0.3)'};display:flex;align-items:center;justify-content:center;transition:all 0.18s;backdrop-filter:blur(4px)"><i class="fa-solid fa-check" style="font-size:0.55rem;color:white;opacity:${isSelected?1:0};transition:opacity 0.15s"></i></div></div>`;
        }).join('');
    } catch(e) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(248,113,113,0.5);font-size:0.8rem">Eroare la încărcare</div>`;
    }
}

function toggleRefsPickerItem(el, url) {
    const maxRefs = getMaxRefs();
    const already = _refsPickerSelected.findIndex(s => s.url === url);
    if(already >= 0) {
        _refsPickerSelected.splice(already, 1);
        el.style.border = '2px solid transparent';
        const check = el.querySelector('.refs-picker-check');
        if(check) { check.style.background='rgba(0,0,0,0.4)'; check.style.borderColor='rgba(255,255,255,0.3)'; check.querySelector('i').style.opacity='0'; }
    } else {
        if(_refsPickerSelected.length >= maxRefs) { toast(`Maxim ${maxRefs} referințe pentru modelul selectat!`); return; }
        _refsPickerSelected.push({ type:'history', url });
        el.style.border = '2px solid rgba(99,102,241,0.7)';
        const check = el.querySelector('.refs-picker-check');
        if(check) { check.style.background='rgba(99,102,241,0.95)'; check.style.borderColor='rgba(165,168,255,0.8)'; check.querySelector('i').style.opacity='1'; }
    }
    renderRefsPickerSelected();
}

function handleRefsPickerUpload(e) {
    const maxRefs = getMaxRefs();
    Array.from(e.target.files).forEach(f => {
        if(_refsPickerSelected.length >= maxRefs) return;
        _refsPickerSelected.push({ type:'upload', file:f, url: URL.createObjectURL(f) });
    });
    renderRefsPickerSelected();
    e.target.value = '';
}

function renderRefsPickerSelected() {
    const wrap = document.getElementById('refs-picker-selected');
    const grid = document.getElementById('refs-picker-selected-grid');
    const label = document.getElementById('refs-picker-count-label');
    const maxRefs = getMaxRefs();
    const n = _refsPickerSelected.length;
    label.textContent = `${n} selectate (max ${maxRefs})`;
    if(!n) { wrap.style.display='none'; return; }
    wrap.style.display='block';
    grid.innerHTML = _refsPickerSelected.map((s,i) => `<div style="position:relative;width:54px;height:54px;border-radius:10px;overflow:hidden;border:1.5px solid rgba(99,102,241,0.4)"><img src="${s.url}" style="width:100%;height:100%;object-fit:cover"><button onclick="removeRefsPickerItem(${i})" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(239,68,68,0.85);border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.5rem"><i class="fa-solid fa-xmark"></i></button></div>`).join('');
}

function removeRefsPickerItem(i) {
    _refsPickerSelected.splice(i, 1);
    renderRefsPickerSelected();
    document.querySelectorAll('.refs-picker-item').forEach(el => {
        const url = el.dataset.url;
        const isSelected = _refsPickerSelected.some(s => s.url === url);
        el.style.border = isSelected ? '2px solid rgba(99,102,241,0.7)' : '2px solid transparent';
        const check = el.querySelector('.refs-picker-check');
        if(check) {
            check.style.background = isSelected ? 'rgba(99,102,241,0.95)' : 'rgba(0,0,0,0.4)';
            check.style.borderColor = isSelected ? 'rgba(165,168,255,0.8)' : 'rgba(255,255,255,0.3)';
            check.querySelector('i').style.opacity = isSelected ? '1' : '0';
        }
    });
}

function getMaxRefs() {
    const model = document.getElementById('model-sel')?.value || '';
    return model === 'gemini-pro' ? 14 : 3;
}

function confirmRefsPicker() {
    uploadedRefs = [];
    const filePromises = _refsPickerSelected.map(async s => {
        if(s.type === 'upload') return s.file;
        try {
            const token = getToken();
            const proxyUrl = `/api/media/proxy-download?url=${encodeURIComponent(s.url)}&filename=ref.jpg`;
            const res = await fetch(proxyUrl, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} });
            if(!res.ok) throw new Error('proxy fail');
            const blob = await res.blob();
            const ext = blob.type.includes('png') ? 'png' : 'jpg';
            return new File([blob], `ref_hist_${Date.now()}.${ext}`, { type: blob.type });
        } catch(e) { return null; }
    });
    Promise.all(filePromises).then(files => {
        uploadedRefs = files.filter(Boolean);
        renderRefGallery();
        closeRefsPicker();
        toast(`${uploadedRefs.length} referință${uploadedRefs.length!==1?'e':''} adăugate!`);
    });
}

// ===================== FRAME PICKER (Start / End) =====================
let _framePickerSlot = 'start';

function openFramePicker(slot) {
    _framePickerSlot = slot;
    const modal = document.getElementById('frame-picker-modal');
    const title = document.getElementById('frame-picker-title');
    title.textContent = slot === 'start' ? '🟢 Start Frame' : '🔴 End Frame';
    modal.style.display = 'flex';
    requestAnimationFrame(() => { modal.style.opacity = '1'; });
    loadFramePickerHistory();
}

function closeFramePicker(e) {
    if(e && e.target !== document.getElementById('frame-picker-modal')) return;
    const modal = document.getElementById('frame-picker-modal');
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 300);
}

async function loadFramePickerHistory() {
    const grid = document.getElementById('frame-picker-grid');
    const token = getToken();
    if(!token) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-lock mb-2 text-lg block" style="color:rgba(255,255,255,0.15)"></i>Conectează-te pentru istoric</div>`;
        return;
    }
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin mb-2 text-lg block" style="color:rgba(99,102,241,0.4)"></i>Se încarcă...</div>`;
    try {
        const res = await fetch('/api/media/history?type=image&page=1&limit=40', { headers:{'Authorization':'Bearer '+token} });
        const data = await res.json();
        const urls = [];
        (data.history||[]).forEach(item => { const u = item.supabaseUrl||item.originalUrl; if(u) urls.push(u); });
        if(!urls.length) {
            grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(255,255,255,0.2);font-size:0.8rem"><i class="fa-solid fa-image mb-2 text-xl block" style="color:rgba(255,255,255,0.1)"></i>Nicio imagine în istoric</div>`;
            return;
        }
        grid.innerHTML = urls.map(url => `<div onclick="selectFrameFromHistory('${escHtml(url)}')" style="aspect-ratio:1;border-radius:12px;overflow:hidden;cursor:pointer;position:relative;border:2px solid transparent;transition:all 0.18s;background:#0a0a16" onmouseover="this.style.borderColor='rgba(99,102,241,0.6)';this.style.transform='scale(1.03)'" onmouseout="this.style.borderColor='transparent';this.style.transform='scale(1)'"><img src="${url}" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'"></div>`).join('');
    } catch(e) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:32px 0;color:rgba(248,113,113,0.5);font-size:0.8rem">Eroare la încărcare</div>`;
    }
}

async function selectFrameFromHistory(url) {
    const token = getToken();
    try {
        const proxyUrl = `/api/media/proxy-download?url=${encodeURIComponent(url)}&filename=frame.jpg`;
        const res = await fetch(proxyUrl, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} });
        if(!res.ok) throw new Error('fail');
        const blob = await res.blob();
        const file = new File([blob], `frame_${Date.now()}.jpg`, { type: blob.type });
        applyFrameFile(_framePickerSlot, file, url);
    } catch(e) { toast('Nu s-a putut încărca imaginea. Încearcă upload manual.'); }
    closeFramePicker();
}

function handleFramePickerUpload(e) {
    const file = e.target.files[0]; if(!file) return;
    const url = URL.createObjectURL(file);
    applyFrameFile(_framePickerSlot, file, url);
    e.target.value = '';
    closeFramePicker();
}

function applyFrameFile(slot, file, previewUrl) {
    if(slot === 'start') {
        startFrameFile = file;
        document.getElementById('start-frame-img').src = previewUrl;
        document.getElementById('start-frame-preview').classList.remove('hidden');
        document.getElementById('start-frame-zone').classList.add('hidden');
    } else {
        endFrameFile = file;
        document.getElementById('end-frame-img').src = previewUrl;
        document.getElementById('end-frame-preview').classList.remove('hidden');
        document.getElementById('end-frame-zone').classList.add('hidden');
    }
}

document.addEventListener('keydown', e => {
    if(e.key==='Escape' && document.getElementById('frame-picker-modal')?.style.display==='flex') closeFramePicker();
});
