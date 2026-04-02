// ===================== HISTORY =====================
async function saveToSupabase(urls,promptText,jobMode,uuids){
    const token=getToken(); if(!token) return;
    try {
        await fetch('/api/media/save-history',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({urls,type:jobMode||mode,prompt:promptText,uuids:uuids||[]})});
    } catch(e){}
}

let historyPage = 1;
let historyLoading = false;
let historyHasMore = true;

async function loadHistory(append=false){
    const token=getToken(); if(!token) return;
    if(historyLoading) return;
    if(!append){ historyPage=1; historyHasMore=true; }
    if(!historyHasMore) return;
    historyLoading=true;
    try {
        const res=await fetch(`/api/media/history?type=${mode}&page=${historyPage}`,{headers:{'Authorization':'Bearer '+token}});
        const data=await res.json();
        const grid=document.getElementById('history-grid');

        if(!append) grid.innerHTML='';

        if(!data.history?.length && !append){
            grid.innerHTML=`<p class="text-sm text-center py-8 rounded-2xl" style="color:rgba(255,255,255,0.2);background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.06)">Nu ai nicio generare recentă.</p>`;
            historyLoading=false; return;
        }

        const oldBtn = grid.querySelector('.history-load-more');
        if(oldBtn) oldBtn.remove();

        let grouped=[];
        data.history.forEach(item=>{
            const last=grouped[grouped.length-1]; const ps=item.prompt||'Fără prompt';
            const url=item.supabaseUrl||item.originalUrl;
            if(!url) return;
            if(last&&last.prompt===ps&&last.type===item.type) {
                last.urls.push(url);
                last.uuids.push(item.uuid||'');
            } else grouped.push({prompt:ps,type:item.type,urls:[url],uuids:[item.uuid||'']});
        });

        if(!append) window.currentHistoryMedia=[];
        else window.currentHistoryMedia=window.currentHistoryMedia||[];

        let counter=window.currentHistoryMedia.length;

        grouped.forEach(g=>g.urls.forEach((u,i)=>window.currentHistoryMedia.push({url:u,type:g.type,uuid:g.uuids[i]||''})));

        grouped.forEach((group,i)=>{
            const mediaHtml=group.urls.map((url,urlIdx)=>{
                const idx=counter++;
                if(group.type==='image') return `
                    <div class="aspect-square rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.03] hover:shadow-lg relative bg-white/5" style="border:1px solid rgba(255,255,255,0.06)" onclick="openLightbox(window.currentHistoryMedia,${idx},'image')">
                        <img src="${url}" loading="lazy" class="w-full h-full object-cover" onerror="this.parentElement.style.opacity='0.3';this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22/>'">
                    </div>`;
                // ★ FIX BUG 1+3: extend button — contained inside overflow:hidden parent, always-visible text, proper padding on mobile
                return `
                    <div class="aspect-video relative rounded-xl overflow-hidden transition-all hover:scale-[1.03]" style="border:1px solid rgba(255,255,255,0.06)">
                        <div onclick="openLightbox(window.currentHistoryMedia,${idx},'video')" class="absolute inset-0 cursor-pointer" style="z-index:1"></div>
                        <video data-src="${url}" class="w-full h-full object-cover hist-video" preload="none" muted playsinline crossorigin="anonymous"
                            onerror="if(!this.dataset.retried){this.dataset.retried='1';setTimeout(()=>{this.src=this.dataset.src+'?r='+Date.now()},1000)}else{this.parentElement.style.opacity='0.3'}"></video>
                        <div class="absolute inset-0 flex items-center justify-center pointer-events-none" style="background:rgba(0,0,0,0.35);z-index:2">
                            <div class="w-10 h-10 rounded-full flex items-center justify-center" style="background:rgba(255,255,255,0.15);border:1.5px solid rgba(255,255,255,0.3);backdrop-filter:blur(4px)">
                                <i class="fa-solid fa-play text-white text-xs ml-0.5"></i>
                            </div>
                        </div>
                        <div style="position:absolute;bottom:6px;right:6px;z-index:3;max-width:calc(100% - 12px)">
                            <button data-url="${url}" data-uuid="${group.uuids[urlIdx]||''}" onclick="event.stopPropagation();openExtendModal(this.dataset.uuid,this.dataset.url)" class="extend-hist-btn flex items-center gap-1 font-bold rounded-lg" style="font-size:0.58rem;padding:4px 8px;background:rgba(99,102,241,0.88);color:white;border:1px solid rgba(165,168,255,0.3);backdrop-filter:blur(4px);white-space:nowrap"><i class="fa-solid fa-forward" style="font-size:0.45rem"></i> Extindere</button>
                        </div>
                    </div>`;
            }).join('');

            const div=document.createElement('div');
            div.className='history-group animate-slide-up';
            div.style.animationDelay=`${i*0.04}s`;
            div.innerHTML=`
                <div class="flex items-start gap-3 mb-3 pb-3" style="border-bottom:1px solid rgba(255,255,255,0.05)">
                    <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style="background:rgba(99,102,241,0.15)">
                        <i class="fa-solid ${group.type==='image'?'fa-image':'fa-clapperboard'} text-xs" style="color:rgba(165,168,255,0.7)"></i>
                    </div>
                    <div class="flex-1 overflow-hidden">
                        <p class="text-[0.8rem] font-medium truncate cursor-pointer hover:text-white transition-colors" style="color:rgba(255,255,255,0.5)" data-prompt="${escHtml(group.prompt)}" onclick="document.getElementById('prompt-in').value=this.dataset.prompt;updateCharCount();">"${escHtml(group.prompt)}"</p>
                        <span class="text-[0.6rem] font-bold uppercase tracking-widest mt-0.5 block" style="color:rgba(255,255,255,0.2)">Generat anterior</span>
                    </div>
                    <button data-prompt="${escHtml(group.prompt)}" onclick="document.getElementById('prompt-in').value=this.dataset.prompt;updateCharCount();" class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:scale-110" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:rgba(255,255,255,0.3)"><i class="fa-solid fa-rotate-right text-xs"></i></button>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-2">${mediaHtml}</div>`;
            grid.appendChild(div);
        });

        historyHasMore = data.page < data.pages;
        historyPage++;

        if(historyHasMore){
            const loadMoreBtn=document.createElement('button');
            loadMoreBtn.className='history-load-more w-full py-3 rounded-xl text-xs font-bold transition-all mt-2';
            loadMoreBtn.style.cssText='color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)';
            loadMoreBtn.innerHTML='<i class="fa-solid fa-chevron-down mr-1.5"></i>Încarcă mai multe';
            loadMoreBtn.onclick=()=>loadHistory(true);
            grid.appendChild(loadMoreBtn);
        }

        historyLoading=false;
        setTimeout(observeHistoryVideos, 50);
    } catch(e){ console.error('Eroare istoric:',e); historyLoading=false; }
}

// ===================== LAZY VIDEO THUMBNAILS =====================
const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if(!entry.isIntersecting) return;
        const video = entry.target;
        if(video.dataset.src && !video.dataset.loaded) {
            video.dataset.loaded = '1';
            video.src = video.dataset.src;
            video.preload = 'metadata';
            const metaTimeout = setTimeout(() => {
                if(video.readyState < 1 && !video.dataset.retried) {
                    video.dataset.retried = '1';
                    video.src = video.dataset.src + '?r=' + Date.now();
                }
            }, 8000);
            video.addEventListener('loadedmetadata', () => {
                clearTimeout(metaTimeout);
                video.currentTime = 0.5;
            }, { once: true });
        }
        videoObserver.unobserve(video);
    });
}, { rootMargin: '300px' });

function observeHistoryVideos(){
    document.querySelectorAll('.hist-video[data-src]').forEach(v => {
        if(!v.dataset.loaded) videoObserver.observe(v);
    });
}
