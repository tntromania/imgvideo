require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const sharp = require('sharp');
sharp.concurrency(1);
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ✅ Auth centralizat prin HUB
const { authenticate, hubAPI } = require('./hub-auth');

// ✅ Construiește multipart/form-data manual cu Buffer nativ Node.js
function buildMultipartBody(fields, files) {
    const boundary = '----ViralioBoundary' + Math.random().toString(36).substring(2);
    const parts = [];

    for (const [name, value] of Object.entries(fields)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
    }

    for (const { fieldname, buffer, mimetype, filename } of files) {
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`;
        parts.push({ header, buffer });
    }

    const buffers = [];
    for (const part of parts) {
        if (typeof part === 'string') {
            buffers.push(Buffer.from(part + '\r\n', 'utf8'));
        } else {
            buffers.push(Buffer.from(part.header, 'utf8'));
            buffers.push(part.buffer);
            buffers.push(Buffer.from('\r\n', 'utf8'));
        }
    }
    buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

    return { body: Buffer.concat(buffers), contentType: `multipart/form-data; boundary=${boundary}` };
}

const app = express();
const PORT = process.env.PORT || 3001;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// ██ R2 STORAGE
// ══════════════════════════════════════════════════════════════
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const uploadToR2 = async (buffer, fileName, contentType) => {
    await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: buffer, ContentType: contentType,
    }));
    return `${process.env.R2_PUBLIC_URL}/${fileName}`;
};

const validateImageForVideo = async (buffer, mimetype, label = 'imagine') => {
    try {
        const meta = await sharp(buffer).metadata();
        const sizeKB = Math.round(buffer.length / 1024);
        console.log(`[Video] 📸 ${label}: ${meta.width}x${meta.height}px, ${meta.format}, ${sizeKB}KB`);

        const issues = [];
        if (meta.width < 128 || meta.height < 128) issues.push(`prea mică (${meta.width}x${meta.height}px, minim 128x128)`);
        if (buffer.length > 15 * 1024 * 1024) issues.push(`prea mare (${sizeKB}KB, max ~15MB)`);
        const allowed = ['jpeg', 'png', 'webp', 'gif'];
        if (!allowed.includes(meta.format)) issues.push(`format nesuportat (${meta.format})`);

        if (issues.length > 0) {
            console.warn(`[Video] ⚠️ Probleme imagine ${label}: ${issues.join(', ')}`);
            return { valid: false, reason: issues.join(', '), meta };
        }
        return { valid: true, meta };
    } catch (e) {
        console.error(`[Video] ❌ Nu pot citi imaginea ${label}: ${e.message}`);
        return { valid: false, reason: 'imaginea nu poate fi citită sau e coruptă' };
    }
};

const compressForVideo = async (buffer, mimetype, model = 'generic') => {
    try {
        // Grok API e sensibil la imagini mari — limităm la 768px și calitate 82
        // Veo acceptă imagini mai mari dar tot comprimăm pentru viteză
        const maxDim = model === 'grok' ? 768 : 1024;
        const quality = model === 'grok' ? 82 : 85;
        const compressed = await sharp(buffer)
            .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality, mozjpeg: true })
            .toBuffer();
        console.log(`[Video] Comprimat (${model}): ${buffer.length} → ${compressed.length} bytes (max ${maxDim}px)`);
        return { buffer: compressed, mimetype: 'image/jpeg' };
    } catch (e) {
        console.warn(`[Video] Comprimare eșuată, reîncerc fără mozjpeg: ${e.message}`);
        try {
            const meta = await sharp(buffer).metadata();
            const maxDim = model === 'grok' ? 768 : 1024;
            const compressed = await sharp(buffer)
                .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
            return { buffer: compressed, mimetype: 'image/jpeg' };
        } catch (e2) {
            console.warn(`[Video] Comprimare eșuată complet, trimit original: ${e2.message}`);
            return { buffer, mimetype };
        }
    }
};

// ══════════════════════════════════════════════════════════════
// ██ MONGODB — DOAR History + Log (NU Users!)
// ══════════════════════════════════════════════════════════════
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Media Studio conectat la MongoDB (history/logs)!'))
        .catch(err => console.error('❌ Eroare MongoDB:', err));
}

const HistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    originalUrl: String, supabaseUrl: String, prompt: String,
    uuid: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});
// ✅ Index compus pentru verificare duplicate rapidă
HistorySchema.index({ userId: 1, originalUrl: 1 });
const History = mongoose.models.History || mongoose.model('History', HistorySchema);

const LogSchema = new mongoose.Schema({
    userEmail: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    count: { type: Number, required: true },
    cost: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Log = mongoose.models.Log || mongoose.model('Log', LogSchema);

// ══════════════════════════════════════════════════════════════
// ██ AUTH ROUTES — proxy către HUB
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
    try {
        const response = await fetch(`${process.env.HUB_URL}/api/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (e) {
        res.status(500).json({ error: 'Nu pot comunica cu serverul principal.' });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    res.json({ user: req.user });
});

// ══════════════════════════════════════════════════════════════
// ██ ADMIN — verificare prin HUB user info
// ══════════════════════════════════════════════════════════════
const ADMIN_EMAILS = ['banicualex3@gmail.com'];
const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Acces interzis!" });
    try {
        // Verificăm token prin HUB
        const result = await fetch(`${process.env.HUB_URL}/api/internal/verify-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
            body: JSON.stringify({ token }),
        });
        const data = await result.json();
        if (!result.ok) return res.status(403).json({ error: "Sesiune invalidă." });
        if (!ADMIN_EMAILS.some(e => e.toLowerCase() === data.user.email.toLowerCase())) {
            return res.status(403).json({ error: "Ai greșit contul?" });
        }
        req.userId = data.userId;
        req.user = data.user;
        next();
    } catch (e) {
        return res.status(401).json({ error: "Sesiune invalidă." });
    }
};

// ══════════════════════════════════════════════════════════════
// ██ HELPERS AI
// ══════════════════════════════════════════════════════════════
const MODEL_PRICES = {
    'gemini-flash': 1, 'nano-banana-pro-1k': 1,
    'gemini-pro': 2,   'nano-banana-pro-2k': 2,
    'veo3.1-fast': 2,
    'veo-extend': 2,
    'grok-720p-6s': 2, 'grok-720p-10s': 2,
    'grok-extend': 2,
};

const fetchWithRetry = async (url, options, maxRetries = 6, delayMs = 5000) => {
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (response.ok) return response;
            const text = await response.text();
            if (response.status === 429 || response.status === 503 || text.toLowerCase().includes('exhausted')) {
                console.warn(`[AI] Aglomerat (${response.status}), reîncerc ${i+1}/${maxRetries}`);
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 2; continue;
            }
            throw new Error(text);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error("Timpul de așteptare a expirat.");
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 2;
            } else throw error;
        }
    }
    throw new Error("Sistemul AI este suprasolicitat.");
};

let imageQueueRunning = false;
const imageQueue = [];
const enqueueImageRequest = (fn) => new Promise((resolve, reject) => {
    imageQueue.push({ fn, resolve, reject });
    processImageQueue();
});
const processImageQueue = async () => {
    if (imageQueueRunning || imageQueue.length === 0) return;
    imageQueueRunning = true;
    const { fn, resolve, reject } = imageQueue.shift();
    try { resolve(await fn()); }
    catch (e) { reject(e); }
    finally { imageQueueRunning = false; setTimeout(processImageQueue, 2000); }
};

// ══════════════════════════════════════════════════════════════
// ██ IMAGINI
// ══════════════════════════════════════════════════════════════
app.post('/api/media/image', authenticate, upload.array('ref_images', 5), async (req, res) => {
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let clientAborted = false;
    res.on('close', () => { if (!res.writableEnded) { clientAborted = true; } });

    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = Math.min(parseInt(number_of_images) || 1, 4);
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        // Verificăm credite prin HUB
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < totalCost) {
            res.write(`data: ${JSON.stringify({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` })}\n\n`);
            res.end(); return;
        }

        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';

        console.log(`[Imagini] START | model=${MODEL_ID} count=${count} cost=${totalCost} | ${req.user.email}`);
        res.write(`data: ${JSON.stringify({ status: `Se pregătește generarea a ${count} imagini...` })}\n\n`);

        let baseParts = [];
        if (req.files && req.files.length > 0) {
            for (let i = 0; i < req.files.length; i++) {
                baseParts.push({ inlineData: { mimeType: req.files[i].mimetype, data: req.files[i].buffer.toString('base64') } });
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt += `\n\n[Instruction: Use the provided images as exact character and style references. Aspect Ratio: ${aspect_ratio}]`;
        } else {
            finalPrompt += `\n\n[Instruction: Aspect Ratio: ${aspect_ratio}]`;
        }
        baseParts.push({ text: finalPrompt });

        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${process.env.VERTEX_API_KEY}`;

        const buildRequestBody = (seed) => {
            const body = {
                contents: [{ role: "user", parts: baseParts }],
                generationConfig: { candidateCount: 1, seed }
            };
            if (isFlash) {
                body.generationConfig.responseModalities = ["IMAGE"];
                body.generationConfig.imageConfig = { aspectRatio: aspect_ratio || "1:1", imageSize: "1K" };
                body.safetySettings = [
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
                ];
            }
            return body;
        };

        const urls = [];
        let completedCount = 0;

        const imagePromises = Array.from({ length: count }, async (_, idx) => {
            if (clientAborted) return;
            const seed = Math.floor(Math.random() * 999999);
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                if (clientAborted) return;
                attempts++;
                try {
                    const response = await fetchWithRetry(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(buildRequestBody(seed + attempts * 1000))
                    });
                    const rawText = await response.text();
                    let data;
                    try { data = JSON.parse(rawText); } catch { continue; }

                    if (data.candidates) {
                        for (const candidate of data.candidates) {
                            if (candidate.content?.parts) {
                                for (const part of candidate.content.parts) {
                                    if (part.inlineData?.data) {
                                        const mime = part.inlineData.mimeType || 'image/png';
                                        const ext = mime.split('/')[1] || 'png';
                                        const buffer = Buffer.from(part.inlineData.data, 'base64');
                                        const fileName = `generated/${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                                        try {
                                            const publicUrl = await uploadToR2(buffer, fileName, mime);
                                            urls.push(publicUrl);
                                            completedCount++;
                                            console.log(`[Imagini] ✅ ${completedCount}/${count} gata: ${publicUrl}`);
                                            if (!clientAborted) res.write(`data: ${JSON.stringify({ status: `${completedCount} din ${count} imagini gata...` })}\n\n`);
                                            return;
                                        } catch (uploadErr) {
                                            console.error(`[Imagini] ❌ R2 upload eșuat: ${uploadErr.message}`);
                                        }
                                    }
                                }
                            }
                            const reason = candidate.finishReason;
                            if (reason && reason !== 'STOP') {
                                console.warn(`[Imagini] Imagine ${idx+1} filtrată (${reason}), reîncerc...`);
                                break;
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Imagini] Eroare imagine ${idx+1}, attempt ${attempts}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 1500));
            }
        });

        await Promise.allSettled(imagePromises);
        if (clientAborted) return;

        if (urls.length === 0) {
            res.write(`data: ${JSON.stringify({ error: "Imaginile nu au putut fi generate. Promptul poate conține elemente blocate." })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end(); return;
        }

        // Scădem creditele prin HUB
        const actualCost = urls.length * costPerImg;
        await Log.create({ userEmail: req.user.email, type: 'image', count: urls.length, cost: actualCost }).catch(() => {});
        try { await hubAPI.useCredits(req.userId, actualCost); } catch (e) { console.error('Eroare scădere credite:', e.message); }

        // ✅ Salvăm istoricul pe SERVER — nu mai depindem de client
        try {
            for (const url of urls) {
                await History.create({ userId: req.userId, type: 'image', originalUrl: url, supabaseUrl: url, prompt: prompt || finalPrompt });
            }
            console.log(`[Imagini] 📝 Istoric salvat server-side: ${urls.length} imagini`);
        } catch (histErr) { console.error('[Imagini] ⚠️ Eroare salvare istoric server-side:', histErr.message); }

        console.log(`[Imagini] ✅ ${urls.length}/${count} imagini gata în ${elapsed()} | -${actualCost} cr | ${req.user.email}`);

        res.write(`data: ${JSON.stringify({ file_urls: urls, saved_to_history: true })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();

    } catch (e) {
        console.error(`[Imagini] ❌ Eroare: ${e.message}`);
        if (!clientAborted) {
            res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
        }
    }
});

// ══════════════════════════════════════════════════════════════
// ██ VIDEO — GeminiGen API
// ══════════════════════════════════════════════════════════════

const toGeminiGenAspect = (ratio, isGrok) => {
    if (isGrok) {
        const map = { '9:16': 'portrait', '3:4': 'portrait', '2:3': 'vertical', '4:5': 'portrait', '16:9': 'landscape', '4:3': 'horizontal', '3:2': 'horizontal', '1:1': 'square' };
        return map[ratio] || 'landscape';
    }
    // Veo: doar 16:9 și 9:16
    return ['9:16','3:4','2:3','4:5'].includes(ratio) ? '9:16' : '16:9';
};

const DISCORD_CONTACT = 'alexcaba pe Discord (discord.gg/h8Ah6VKDzm)';

const mapVideoError = (msg) => {
    if (!msg) return 'Eroare necunoscută la generarea video.';
    if (msg.includes('PUBLIC_ERROR_SEXUAL') || msg.includes('sexual')) return '🚫 Conținutul a fost blocat: elemente inadecvate.';
    if (msg.includes('UNSAFE_GENERATION') || msg.includes('unsafe') || msg.includes('PUBLIC_ERROR_DANGER_FILTER') || msg.includes('safety'))
        return '🚫 Conținut blocat de filtrul de siguranță. Modifică promptul.';
    if (msg.includes('AUDIO_FILTERED')) return '🚫 Audio-ul filtrat — conține elemente inadecvate.';
    if (msg.includes('TIMED_OUT') || msg.includes('TIMEOUT') || msg.includes('timeout'))
        return 'Generarea a durat prea mult. Reîncearcă.';
    if (msg.includes('quota') || msg.includes('QUOTA') || msg.includes('rate limit') || msg.includes('RATE_LIMIT') || msg.includes('insufficient') || msg.includes('balance') || msg.includes('credit'))
        return `⚠️ Capacitatea serverelor AI atinsă. Contactează ${DISCORD_CONTACT}`;
    if (msg.includes('Create video error') || msg.includes('Create video failed'))
        return '⚠️ Serverele AI au respins generarea. Posibile cauze: imaginea conține fețe celebre, sau promptul include oameni celebrii. Încearcă cu o altă imagine sau modifică promptul.';
    if (msg === 'terminated' || msg.includes('UND_ERR') || msg.includes('other side closed') || msg.includes('Stream inchis'))
        return '⚠️ Conexiunea cu serverele AI a fost intrerupta dupa toate reincercarile. Te rugam sa reincerci.';
    return msg.replace(/genaipro/gi, 'serverul AI').replace(/dubvoice/gi, 'serverul AI').replace(/geminigen/gi, 'serverul AI').replace(/\bGrok\b/gi, 'serverul video').replace(/\bVeo\s*3?\b/gi, 'serverul video');
};

const isNonRetryableError = (msg) => {
    if (!msg) return false;
    return msg.includes('PUBLIC_ERROR_DANGER_FILTER') || msg.includes('UNSAFE_GENERATION') ||
           msg.includes('AUDIO_FILTERED') || msg.includes('PUBLIC_ERROR_SEXUAL') ||
           msg.includes('quota') || msg.includes('QUOTA') || msg.includes('rate limit') ||
           msg.includes('RATE_LIMIT') || msg.includes('insufficient') || msg.includes('balance');
};

// ── GeminiGen: Polling pe History API ────────────────────────────
const pollGeminiGenResult = async (uuid, apiKey, emailTag, maxPolls = 90, intervalMs = 4000) => {
    for (let poll = 1; poll <= maxPolls; poll++) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const res = await fetch(`https://api.geminigen.ai/uapi/v1/history/${uuid}`, {
                headers: { 'x-api-key': apiKey }
            });
            const data = await res.json();
            const result = data?.result || data;

            const status = result.status;
            const pct = result.status_percentage || 0;

            if (poll <= 3 || poll % 10 === 0) {
                console.log(`[GeminiGen] Poll ${poll}/${maxPolls} uuid=${uuid} status=${status} pct=${pct}% | ${emailTag}`);
            }

            if (status === 2) {
                // Structura reală: generated_video[0].video_url
                const videoUrl = result.generated_video?.[0]?.video_url
                    || result.generated_video?.[0]?.url;
                if (videoUrl) return { success: true, url: videoUrl };
                // Fallback la alte câmpuri
                const mediaUrl = result.generate_result || result.media_url || result.url;
                if (mediaUrl) return { success: true, url: mediaUrl };
                console.error(`[GeminiGen] Status 2 dar fără URL! Keys: ${Object.keys(result).join(', ')}`);
                return { success: false, error: 'Video gata dar fără URL.' };
            }

            if (status === 3) {
                const errMsg = result.error_message || result.status_desc || result.error_code || '';
                // GeminiGen returnează erori specifice pe care le mapăm
                if (errMsg.toLowerCase().includes('audio')) {
                    return { success: false, error: '🔊 Generarea audio a eșuat (promptul poate conține elemente blocate). Modifică promptul și reîncearcă.' };
                }
                if (errMsg.toLowerCase().includes('safety') || errMsg.toLowerCase().includes('filter') || errMsg.toLowerCase().includes('blocked')) {
                    return { success: false, error: '🚫 Conținut blocat de filtrul de siguranță. Modifică promptul.' };
                }
                if (errMsg.toLowerCase().includes('person') || errMsg.toLowerCase().includes('face') || errMsg.toLowerCase().includes('human')) {
                    return { success: false, error: '🚫 Promptul sau imaginea conține persoane/fețe care au fost blocate. Încearcă fără imagini cu persoane reale.' };
                }
                return { success: false, error: errMsg || 'Generarea a eșuat pe serverele AI. Reîncearcă.' };
            }

            // status === 1 → still processing
        } catch (e) {
            console.warn(`[GeminiGen] Poll ${poll} eroare rețea: ${e.message}`);
        }
    }
    return { success: false, error: 'Timeout: generarea video a durat prea mult.' };
};

app.post('/api/media/video',
    authenticate,
    upload.fields([
        { name: 'start_image', maxCount: 1 },
        { name: 'end_image',   maxCount: 1 },
        { name: 'ref_images',  maxCount: 5 }
    ]),
    async (req, res) => {
        const startTime = Date.now();
        const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        let clientAborted = false;
        res.on('close', () => { if (!res.writableEnded) clientAborted = true; });

        const keepAliveInterval = setInterval(() => {
            if (!res.writableEnded && !clientAborted) {
                res.write(': keep-alive\n\n');
            } else {
                clearInterval(keepAliveInterval);
            }
        }, 20000);
        const clearKeepAlive = () => clearInterval(keepAliveInterval);

        const sendStatus = (status) => { if (!res.writableEnded && !clientAborted) res.write(`data: ${JSON.stringify({ status })}\n\n`); };
        const sendDone = (urls, uuids) => {
            clearKeepAlive();
            if (!res.writableEnded && !clientAborted) {
                res.write(`data: ${JSON.stringify({ file_urls: urls, file_uuids: uuids || [], saved_to_history: true })}\n\n`);
                res.write('data: [DONE]\n\n'); res.end();
            }
        };
        const sendError = (msg) => {
            clearKeepAlive();
            if (!res.writableEnded && !clientAborted) {
                res.write(`data: ${JSON.stringify({ error: mapVideoError(msg) })}\n\n`);
                res.write('data: [DONE]\n\n'); res.end();
            }
        };

        try {
            const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
            let finalPrompt = prompt;
            const count = parseInt(number_of_videos) || 1;
            const costPerVid = MODEL_PRICES[model_id] || 2;
            const totalCost = count * costPerVid;

            const GEMINIGEN_API_KEY = process.env.GEMINIGEN_API_KEY;
            if (!GEMINIGEN_API_KEY) {
                return sendError('Cheia API GeminiGen nu este configurată. Contactează administratorul.');
            }

            // Verificăm credite prin HUB
            const balance = await hubAPI.checkCredits(req.userId);
            if (balance.credits < totalCost) return sendError(`Fonduri insuficiente! Ai nevoie de ${totalCost} credite.`);

            const startImageFile = req.files?.['start_image']?.[0] || null;
            const endImageFile   = req.files?.['end_image']?.[0]   || null;
            const refImages      = req.files?.['ref_images']        || [];

            // Validare imagini
            if (startImageFile) {
                const v = await validateImageForVideo(startImageFile.buffer, startImageFile.mimetype, 'start_image');
                if (!v.valid) return sendError(`Imaginea de start are probleme: ${v.reason}. Te rugăm să folosești o altă imagine (JPEG/PNG, minim 128x128px).`);
            }
            if (endImageFile) {
                const v = await validateImageForVideo(endImageFile.buffer, endImageFile.mimetype, 'end_image');
                if (!v.valid) return sendError(`Imaginea de final are probleme: ${v.reason}. Te rugăm să folosești o altă imagine (JPEG/PNG, minim 128x128px).`);
            }

            const emailTag = req.user.email;
            const isGrok = model_id.startsWith('grok-') && model_id !== 'grok-extend';
            const isGrokExtend = model_id === 'grok-extend';
            const isVeoExtend = model_id === 'veo-extend';
            const isVeo = model_id.startsWith('veo') && !isVeoExtend;

            // ─── Determină endpoint și parametri ─────────────────────────
            let apiEndpoint, apiModel, resolution, duration, grokAspect;

            if (isGrok) {
                apiEndpoint = 'https://api.geminigen.ai/uapi/v1/video-gen/grok';
                apiModel = 'grok-3';
                resolution = '720p';
                duration = model_id === 'grok-720p-10s' ? 10 : 6;
                grokAspect = toGeminiGenAspect(aspect_ratio, true);
            } else if (isGrokExtend) {
                apiEndpoint = 'https://api.geminigen.ai/uapi/v1/video-extend/grok';
                apiModel = 'grok-3';
                resolution = '720p';
                duration = parseInt(req.body.extend_duration) === 6 ? 6 : 10;
                grokAspect = toGeminiGenAspect(aspect_ratio, true);
            } else if (isVeoExtend) {
                apiEndpoint = 'https://api.geminigen.ai/uapi/v1/video-extend/veo';
                apiModel = 'veo-2';
                resolution = '1080p';
                duration = 8;
                grokAspect = toGeminiGenAspect(aspect_ratio, false);
            } else {
                // Veo 3.1 Fast
                apiEndpoint = 'https://api.geminigen.ai/uapi/v1/video-gen/veo';
                apiModel = 'veo-3.1-fast';
                resolution = '1080p';
                duration = 8; // fixed
                grokAspect = toGeminiGenAspect(aspect_ratio, false);
            }

            // ─── Validare ref_history pentru extend ──────────────────────
            const refHistory = req.body.ref_history || null;
            if ((isGrokExtend || isVeoExtend) && !refHistory) {
                return sendError('Pentru Extend trebuie să selectezi un videoclip existent (ref_history UUID).');
            }

            console.log(`[Video] START | model=${model_id} → api=${apiModel} res=${resolution} dur=${duration}s count=${count} cost=${totalCost} | ${emailTag}`);
            sendStatus('Se trimite cererea video...');

            // ─── Trimitem cererile paralel (count videoclipuri) ─────────
            const videoUrls = [];
            let lastVideoError = null;
            const videoPromises = Array.from({ length: count }, async (_, idx) => {
                if (clientAborted) return;

                try {
                    // Build multipart form data
                    const formData = new FormData();
                    formData.append('prompt', finalPrompt);

                    // ── Extend endpoints: trimit ref_history + prompt ──────
                    if (isGrokExtend || isVeoExtend) {
                        formData.append('ref_history', refHistory);
                        if (isGrokExtend) {
                            formData.append('duration', String(duration));
                        }
                        console.log(`[Video] POST ${idx+1}/${count} → ${apiEndpoint} (extend) ref=${refHistory} dur=${duration}s | ${emailTag}`);
                    } else {
                        // ── Generare normală ──────────────────────────────
                        formData.append('model', apiModel);
                        formData.append('resolution', resolution);

                        if (isGrok) {
                            formData.append('aspect_ratio', grokAspect);
                            formData.append('duration', String(duration));
                        } else {
                            formData.append('aspect_ratio', grokAspect);
                        }

                        // Grok: fișiere în 'files' | Veo: fișiere în 'ref_images'
                        const compressModel = isGrok ? 'grok' : 'veo';
                        if (isGrok) {
                            if (startImageFile) {
                                const compressed = await compressForVideo(startImageFile.buffer, startImageFile.mimetype, 'grok');
                                const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                formData.append('files', blob, `start_frame.jpg`);
                            }
                            if (endImageFile) {
                                const compressed = await compressForVideo(endImageFile.buffer, endImageFile.mimetype, 'grok');
                                const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                formData.append('files', blob, `end_frame.jpg`);
                            }
                            if (!startImageFile && !endImageFile && refImages.length > 0) {
                                for (const ref of refImages.slice(0, 3)) {
                                    const compressed = await compressForVideo(ref.buffer, ref.mimetype, 'grok');
                                    const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                    formData.append('files', blob, `ref.jpg`);
                                }
                            }
                        } else {
                            if (startImageFile) {
                                const compressed = await compressForVideo(startImageFile.buffer, startImageFile.mimetype, 'veo');
                                const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                formData.append('ref_images', blob, `start_frame.jpg`);
                            }
                            if (endImageFile) {
                                const compressed = await compressForVideo(endImageFile.buffer, endImageFile.mimetype, 'veo');
                                const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                formData.append('ref_images', blob, `end_frame.jpg`);
                            }
                            if (!startImageFile && !endImageFile && refImages.length > 0) {
                                for (const ref of refImages.slice(0, 3)) {
                                    const compressed = await compressForVideo(ref.buffer, ref.mimetype, 'veo');
                                    const blob = new Blob([compressed.buffer], { type: compressed.mimetype });
                                    formData.append('ref_images', blob, `ref.jpg`);
                                }
                            }
                            if (startImageFile) {
                                formData.append('mode_image', 'frame');
                            }
                        }

                        console.log(`[Video] POST ${idx+1}/${count} → ${apiEndpoint} model=${apiModel} | ${emailTag}`);
                    } // end else (non-extend)

                    const postRes = await fetchWithRetry(apiEndpoint, {
                        method: 'POST',
                        headers: { 'x-api-key': GEMINIGEN_API_KEY },
                        body: formData
                    }, 3, 5000);

                    const postText = await postRes.text();
                    let postData;
                    try { postData = JSON.parse(postText); } catch { throw new Error(`Răspuns invalid de la server: ${postText.substring(0, 200)}`); }

                    console.log(`[Video] POST ${idx+1} → status=${postRes.status} uuid=${postData.uuid || 'N/A'} | ${emailTag}`);

                    if (!postRes.ok) {
                        throw new Error(postData.error || postData.message || postData.detail || `HTTP ${postRes.status}`);
                    }

                    const uuid = postData.uuid;
                    if (!uuid) {
                        // Poate a returnat direct un URL
                        const directUrl = postData.media_url || postData.video_url || postData.url;
                        if (directUrl) { videoUrls.push(directUrl); return; }
                        throw new Error('Niciun UUID în răspunsul serverului.');
                    }

                    sendStatus(`Se generează videoclipul ${count > 1 ? `${idx+1}/${count}` : ''}...`);

                    // ── Polling ────────────────────────────────────────────
                    const result = await pollGeminiGenResult(uuid, GEMINIGEN_API_KEY, emailTag);

                    if (result.success) {
                        // Urcăm videoclipul pe R2 pentru stocare permanentă
                        let finalUrl = result.url;
                        try {
                            sendStatus(`Se salvează videoclipul ${count > 1 ? `${idx+1}/${count}` : ''}...`);
                            const videoFetch = await fetch(result.url, {
                                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralioBOT/1.0)' }
                            });
                            if (videoFetch.ok) {
                                const videoBuffer = Buffer.from(await videoFetch.arrayBuffer());
                                const fileName = `videos/${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`;
                                finalUrl = await uploadToR2(videoBuffer, fileName, 'video/mp4');
                                console.log(`[Video] ✅ R2 upload: ${finalUrl} | ${emailTag}`);
                            } else {
                                console.warn(`[Video] ⚠️ Nu am putut descărca videoclipul pentru R2, folosesc URL original | ${emailTag}`);
                            }
                        } catch (uploadErr) {
                            console.warn(`[Video] ⚠️ R2 upload eșuat, folosesc URL original: ${uploadErr.message} | ${emailTag}`);
                        }
                        // Salvăm și UUID-ul GeminiGen pentru extend
                        videoUrls.push({ url: finalUrl, uuid });
                        console.log(`[Video] ✅ ${idx+1}/${count} gata: ${finalUrl} | uuid=${uuid} | ${emailTag}`);
                        if (!clientAborted) sendStatus(`${videoUrls.length} din ${count} videoclipuri gata...`);
                    } else {
                        lastVideoError = result.error;
                        console.error(`[Video] ❌ ${idx+1}/${count}: ${result.error} | ${emailTag}`);
                        if (count === 1) throw new Error(result.error);
                    }

                } catch (e) {
                    console.error(`[Video] ❌ Video ${idx+1} eroare: ${e.message} | ${emailTag}`);
                    if (count === 1) throw e;
                }
            });

            await Promise.allSettled(videoPromises);
            if (clientAborted) { clearKeepAlive(); return; }

            if (videoUrls.length === 0) {
                // Colectăm erorile reale din videoclipurile eșuate pentru a le afișa
                return sendError(lastVideoError || 'Nu s-a putut genera niciun videoclip. Reîncearcă sau modifică promptul.');
            }

            // Scădem creditele
            const actualCost = videoUrls.length * costPerVid;
            await Log.create({ userEmail: req.user.email, type: 'video', count: videoUrls.length, cost: actualCost }).catch(() => {});
            try { await hubAPI.useCredits(req.userId, actualCost); } catch (e) { console.error('Eroare scădere credite video:', e.message); }

            // ✅ Salvăm istoricul pe SERVER — nu mai depindem de client
            try {
                for (let i = 0; i < videoUrls.length; i++) {
                    await History.create({
                        userId: req.userId, type: 'video',
                        originalUrl: videoUrls[i].url, supabaseUrl: videoUrls[i].url,
                        prompt: prompt || finalPrompt,
                        uuid: videoUrls[i].uuid || null,
                    });
                }
                console.log(`[Video] 📝 Istoric salvat server-side: ${videoUrls.length} videoclipuri`);
            } catch (histErr) { console.error('[Video] ⚠️ Eroare salvare istoric server-side:', histErr.message); }

            console.log(`[Video] ✅ ${videoUrls.length}/${count} gata în ${elapsed()} | -${actualCost} cr | ${emailTag}`);
            // Trimitem URL-urile și UUID-urile pentru extend
            const plainUrls = videoUrls.map(v => v.url);
            const uuids = videoUrls.map(v => v.uuid);
            return sendDone(plainUrls, uuids);

        } catch (e) {
            console.error(`[Video] ❌ Eroare neașteptată: ${e.message}`);
            sendError(e.message);
        }
    }
);

// ══════════════════════════════════════════════════════════════
// ██ ALTE RUTE
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const logs = await Log.find().sort({ createdAt: -1 }).limit(100);
        const totalImages = await Log.aggregate([{ $match: { type: 'image' } }, { $group: { _id: null, total: { $sum: "$count" } } }]);
        const totalVideos = await Log.aggregate([{ $match: { type: 'video' } }, { $group: { _id: null, total: { $sum: "$count" } } }]);
        res.json({ totalImages: totalImages[0]?.total || 0, totalVideos: totalVideos[0]?.total || 0, recentLogs: logs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/api-quota', authenticateAdmin, async (req, res) => {
    res.json({ balance: 0, veoTotal: 0, veoUsed: 0, veoAvail: 0 });
});

app.get('/api/media/history', authenticate, async (req, res) => {
    try {
        const type = req.query.type || 'image';
        const page = parseInt(req.query.page) || 1;
        const limit = 80;
        const skip = (page - 1) * limit;
        const history = await History.find({ userId: req.userId, type }).sort({ createdAt: -1 }).skip(skip).limit(limit);
        const total = await History.countDocuments({ userId: req.userId, type });
        res.json({ history, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/media/save-history', authenticate, async (req, res) => {
    const { urls, type, prompt, uuids } = req.body;
    if (!urls || !urls.length) return res.status(400).json({ error: 'Fără URL-uri.' });
    try {
        let savedCount = 0;
        for (let i = 0; i < urls.length; i++) {
            // ✅ Verificăm dacă URL-ul există deja (protecție anti-duplicate)
            const existing = await History.findOne({ userId: req.userId, originalUrl: urls[i] });
            if (existing) { continue; }
            await History.create({
                userId: req.userId, type,
                originalUrl: urls[i], supabaseUrl: urls[i],
                prompt,
                uuid: (uuids && uuids[i]) ? uuids[i] : null,
            });
            savedCount++;
        }
        res.status(200).json({ message: savedCount > 0 ? `${savedCount} salvate` : 'Deja existau în istoric' });
    } catch (err) { res.status(500).json({ error: 'Eroare server' }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const APP_VERSION = Date.now().toString();
app.get('/api/version', (req, res) => { res.json({ version: APP_VERSION }); });

app.get('/api/media/proxy-download', authenticate, async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const r = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralioBOT/1.0)' }
        });
        clearTimeout(timeoutId);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buffer = await r.arrayBuffer();
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'viralio_media'}"`);
        res.setHeader('Content-Length', buffer.byteLength);
        res.send(Buffer.from(buffer));
    } catch(e) {
        console.error(`[Proxy] Download eșuat pentru ${url}: ${e.message}`);
        res.status(500).json({ error: 'Fișierul nu mai este disponibil sau a expirat.' });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

process.on('uncaughtException', (err) => { console.error('❌ uncaughtException:', err.message); });
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    const isKnownSocketError = msg === 'terminated' || msg.includes('UND_ERR_SOCKET') || msg.includes('other side closed') || msg.includes('UND_ERR_CONNECT_TIMEOUT');
    if (isKnownSocketError) {
        console.warn(`[Socket] Eroare conexiune ignorată (normală): ${msg}`);
        return;
    }
    console.error('❌ unhandledRejection:', reason);
});

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));