require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
sharp.concurrency(1); // folosește un singur thread
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ✅ Construiește multipart/form-data manual cu Buffer nativ Node.js (fără dependențe externe)
function buildMultipartBody(fields, files) {
    const boundary = '----ViralioBoundary' + Math.random().toString(36).substring(2);
    const parts = [];

    for (const [name, value] of Object.entries(fields)) {
        parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
        );
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

    return {
        body: Buffer.concat(buffers),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

const app = express();
const PORT = process.env.PORT || 3001;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// ==================== R2 STORAGE =========================================
// =========================================================================
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
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: buffer,
        ContentType: contentType,
    }));
    return `${process.env.R2_PUBLIC_URL}/${fileName}`;
};

const compressForVideo = async (buffer, mimetype) => {
    try {
        const compressed = await sharp(buffer)
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        console.log(`[Video] Comprimat: ${buffer.length} → ${compressed.length} bytes`);
        return { buffer: compressed, mimetype: 'image/jpeg' };
    } catch (e) {
        console.warn(`[Video] Comprimare eșuată, trimit original: ${e.message}`);
        return { buffer, mimetype };
    }
};

// =========================================================================
// ==================== MONGODB ============================================
// =========================================================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Media Studio conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    name: String, picture: String,
    credits: { type: Number, default: 10 },
    voice_characters: { type: Number, default: 3000 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// Păstrăm Supabase DOAR pentru MongoDB/auth — NU pentru storage
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const HistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    originalUrl: String, supabaseUrl: String, prompt: String,
    createdAt: { type: Date, default: Date.now }
});
const History = mongoose.models.History || mongoose.model('History', HistorySchema);

const LogSchema = new mongoose.Schema({
    userEmail: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    count: { type: Number, required: true },
    cost: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Log = mongoose.models.Log || mongoose.model('Log', LogSchema);

// =========================================================================
// ==================== AUTH ===============================================
// =========================================================================
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) { return res.status(401).json({ error: "Sesiune expirată." }); }
};

const ADMIN_EMAILS = ['banicualex3@gmail.com'];
const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Acces interzis!" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(403).json({ error: "Cont inexistent." });
        if (ADMIN_EMAILS.some(e => e.toLowerCase() === user.email.toLowerCase())) {
            req.userId = decoded.userId; next();
        } else { res.status(403).json({ error: "Ai greșit contul?" }); }
    } catch (e) { return res.status(401).json({ error: "Sesiune invalidă." }); }
};

app.post('/api/auth/google', async (req, res) => {
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        let user = await User.findOne({ googleId: payload.sub });
        if (!user) {
            user = new User({ googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture });
            await user.save();
        }
        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token: sessionToken, user });
    } catch (error) { res.status(400).json({ error: "Eroare la autentificarea cu Google." }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user });
});

// =========================================================================
// ==================== HELPERS AI =========================================
// =========================================================================
const MODEL_PRICES = {
    'gemini-flash': 1, 'nano-banana-pro-1k': 1,
    'gemini-pro': 2,   'nano-banana-pro-2k': 2,
    'veo3.1': 3,       'veo3.1fast': 2,
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
                console.warn(`[AI] Aglomerat (${response.status}), reîncerc ${i+1}/${maxRetries} în ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 2;
                continue;
            }
            throw new Error(text);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error("Timpul de așteptare a expirat.");
            if (i < maxRetries - 1) {
                console.warn(`[Network] Eroare conexiune, reîncerc în ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 2;
            } else throw error;
        }
    }
    throw new Error("Sistemul AI este suprasolicitat. Te rugăm să încerci din nou.");
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

// =========================================================================
// ==================== IMAGINI ============================================
// =========================================================================
app.post('/api/media/image', authenticate, upload.array('ref_images', 5), async (req, res) => {
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    let clientAborted = false;

    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = Math.min(parseInt(number_of_images) || 1, 4); // max 4
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (!user) return res.status(401).json({ error: "User negăsit." });
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';

        console.log(`[Imagini] START | model=${MODEL_ID} count=${count} cost=${totalCost} | ${user.email}`);

        // ✅ Construiește parts o singură dată
        let baseParts = [];
        if (req.files && req.files.length > 0) {
            console.log(`[Imagini] ${req.files.length} imagini referință primite`);
            for (let i = 0; i < req.files.length; i++) {
                baseParts.push({ inlineData: { mimeType: req.files[i].mimetype, data: req.files[i].buffer.toString('base64') } });
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt += `\n\n[Instruction: Use the provided images as exact character and style references. Aspect Ratio: ${aspect_ratio}]`;
        } else {
            finalPrompt += `\n\n[Instruction: Aspect Ratio: ${aspect_ratio}]`;
        }
        baseParts.push({ text: finalPrompt });

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

        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${process.env.VERTEX_API_KEY}`;

        // ✅ Trimite N request-uri în paralel, fiecare cu seed diferit
        const seeds = Array.from({ length: count }, () => Math.floor(Math.random() * 999999));
        console.log(`[Imagini] Trimit ${count} request-uri paralel... | ${user.email}`);

const results = await Promise.allSettled(
    seeds.map((seed) =>
        fetchWithRetry(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody(seed))
        })
    )
);

        if (clientAborted) {
            console.log(`[Imagini] ⚠️ Anulat de client după răspuns AI | ${user.email}`);
            return;
        }

        let urls = [];
        const finishReasons = [];

        for (const result of results) {
            if (result.status === 'rejected') {
                console.error(`[Imagini] Request eșuat: ${result.reason?.message}`);
                continue;
            }
            const apiRes = result.value;
            const rawText = await apiRes.text();
            let data;
            try { data = JSON.parse(rawText); }
            catch { console.error(`[Imagini] JSON invalid`); continue; }

            if (!apiRes.ok) {
                console.error(`[Imagini] Vertex error: ${data.error?.message}`);
                continue;
            }

            if (data.candidates) {
                for (const candidate of data.candidates) {
                    finishReasons.push(candidate.finishReason || 'unknown');
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
                                    console.log(`[Imagini] ✅ Upload OK: ${publicUrl}`);
                                } catch (uploadErr) {
                                    console.error(`[Imagini] ❌ R2 upload eșuat: ${uploadErr.message}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        if (clientAborted) return;

        if (urls.length === 0) {
            console.error(`[Imagini] ❌ 0 imagini. finishReasons: [${finishReasons.join(', ')}]`);
            throw new Error("Imaginea nu a putut fi generată. Promptul poate conține elemente blocate de filtrul de siguranță — încearcă să îl modifici.");
        }

        await Log.create({ userEmail: user.email, type: 'image', count: urls.length, cost: urls.length * costPerImg });
        user.credits -= (urls.length * costPerImg);
        await user.save();
        console.log(`[Imagini] ✅ ${urls.length}/${count} imagini gata în ${elapsed()} | -${urls.length * costPerImg} cr | ${user.email}`);

        if (clientAborted) return;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.on('close', () => {
            if (!res.writableEnded) {
                clientAborted = true;
                console.log(`[Imagini] ⚠️ Client a anulat | ${req.userId}`);
            }
        });
        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (e) {
        console.error(`[Imagini] ❌ Eroare la ${elapsed()}: ${e.message}`);
        if (!res.headersSent && !clientAborted) {
            res.status(500).json({ error: e.message });
        }
    }
});

// =========================================================================
// ==================== VIDEO WUYINKEJI (async + polling) ==================
// =========================================================================

const WUYIN_API_URL = 'https://api.wuyinkeji.com/api/async';
const WUYIN_DETAIL_URL = 'https://api.wuyinkeji.com/api/async/detail';
const WUYIN_POLL_INTERVAL_MS = 4000;   // poll la 4s
const WUYIN_MAX_WAIT_MS = 360000;      // max 6 minute

const toWuyinRatio = (ratio) => {
    // suportă doar 16:9 și 9:16
    const portrait = ['9:16', '4:5', '3:4', '2:3'];
    return portrait.includes(ratio) ? '9:16' : '16:9';
};

const pollWuyinResult = async (jobId, apiKey, emailTag, onStatus, abortSignal) => {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
        if (abortSignal?.aborted) throw new Error('client_aborted');

        await new Promise(r => setTimeout(r, WUYIN_POLL_INTERVAL_MS));

        if (Date.now() - startTime > WUYIN_MAX_WAIT_MS) {
            throw new Error('Timeout: generarea a durat prea mult.');
        }

        attempt++;
        let data;
        try {
            const res = await fetch(`${WUYIN_DETAIL_URL}?id=${jobId}`, {
                headers: { 'Authorization': process.env.WUYIN_API_KEY, 'Content-Type': 'application/json' }
            });
            data = await res.json();
        } catch (e) {
            console.warn(`[WuyinPoll] Eroare fetch attempt ${attempt}: ${e.message} | ${emailTag}`);
            continue;
        }

        const status = data?.data?.status;
        console.log(`[WuyinPoll] attempt=${attempt} status=${status} | ${emailTag}`);

if (status === 2) {
    const d = data.data;
    console.log(`[WuyinPoll] status=2 data: ${JSON.stringify(d)}`); 
    
    // Am adăugat verificarea pentru d.result la final
    const url = d.file_url || d.video_url || d.url ||
        (Array.isArray(d.file_urls) ? d.file_urls[0] : null) ||
        (Array.isArray(d.urls) ? d.urls[0] : null) ||
        (Array.isArray(d.result) ? d.result[0] : (typeof d.result === 'string' ? d.result : null));
        
    if (!url) throw new Error('Răspuns succes dar fără URL video.');
    return url;
}

        if (status === 3) {
            const msg = data?.data?.message || 'Generarea a eșuat.';
            throw new Error(msg);
        }

        // status 0 sau 1 — încă se procesează
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (onStatus) onStatus(`Se procesează... (${elapsed}s)`);
    }
};

app.post('/api/media/video/fast',
    authenticate,
    upload.fields([
        { name: 'start_image', maxCount: 1 },
        { name: 'end_image',   maxCount: 1 },
        { name: 'ref_images',  maxCount: 3 }
    ]),
    async (req, res) => {
        const startTime = Date.now();
        const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let clientAborted = false;
        const abortController = { aborted: false };
        res.on('close', () => {
            if (!res.writableEnded) {
                clientAborted = true;
                abortController.aborted = true;
                console.log(`[Video] ⚠️ Client a anulat | ${req.userId}`);
            }
        });

        const sendStatus = (status) => { if (!res.writableEnded && !clientAborted) res.write(`data: ${JSON.stringify({ status })}\n\n`); };
        const sendDone = (urls) => { if (!res.writableEnded && !clientAborted) { res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } };
        const sendError = (msg) => { if (!res.writableEnded && !clientAborted) { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } };

        try {
            const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
            const count = parseInt(number_of_videos) || 1;
            const costPerVid = MODEL_PRICES[model_id] || 3;
            const totalCost = count * costPerVid;
            const videoRatio = toWuyinRatio(aspect_ratio);

            const user = await User.findById(req.userId);
            if (!user) return sendError('User negăsit.');
            if (user.credits < totalCost) return sendError(`Fonduri insuficiente! Ai nevoie de ${totalCost} credite.`);

            const emailTag = user.email;
            const startImageFile = req.files?.['start_image']?.[0] || null;
            const endImageFile   = req.files?.['end_image']?.[0]   || null;
            const refImages      = req.files?.['ref_images']        || [];

            let finalPrompt = prompt;
            const hasFrames = startImageFile || endImageFile;
            const refUrls = [];
            
            if (!hasFrames) {
                for (let i = 0; i < Math.min(refImages.length, 3); i++) {
                    const url = await uploadImageToR2(refImages[i], req.userId, 'refs');
                    refUrls.push(url);
                    finalPrompt = finalPrompt.replace(new RegExp(`@img${i + 1}`, 'g'), '').trim();
                }
            }

            let requestBody;
// ✅ Endpoint-ul corect pentru FAST conform documentației Wuyin
            const endpoint = `${WUYIN_API_URL}/video_veo3.1_fast`;

            if (hasFrames) {
                const frameUrls = {};
                // ✅ Parametrii corecți ceruți de API: firstFrameUrl și lastFrameUrl
                if (startImageFile) frameUrls.firstFrameUrl = await uploadImageToR2(startImageFile, req.userId, 'frames');
                if (endImageFile) frameUrls.lastFrameUrl = await uploadImageToR2(endImageFile, req.userId, 'frames');
                
                requestBody = { prompt: finalPrompt, aspectRatio: videoRatio, size: '1080p', ...frameUrls };
            } else if (refUrls.length > 0) {
                requestBody = { prompt: finalPrompt, aspectRatio: videoRatio, size: '1080p', urls: refUrls };
            } else {
                requestBody = { prompt: finalPrompt, aspectRatio: videoRatio, size: '1080p' };
            }

            console.log(`[Video] START | ratio=${videoRatio} cost=${totalCost} hasFrames=${hasFrames} | ${emailTag}`);
            sendStatus('Se trimite cererea...');

const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': process.env.WUYIN_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
});

const rawText = await submitRes.text(); // Citim răspunsul ca text mai întâi

let submitData;
try {
    submitData = JSON.parse(rawText); // Încercăm să îl facem JSON
} catch (parseError) {
    // Dacă pică, înseamnă că am primit HTML/Eroare de la ei. Returnăm eroarea clară.
    console.error(`[Video] Eroare parsare JSON de la Wuyin. Răspuns primit: ${rawText.substring(0, 200)}`);
    return sendError(`Eroare comunicare API (a returnat HTML în loc de JSON). Cod HTTP: ${submitRes.status}`);
}

if (!submitRes.ok || submitData.code !== 200) {
    return sendError(`Eroare server: ${submitData?.msg || submitData?.message || submitRes.status}`);
}

            const jobId = submitData?.data?.id;
            if (!jobId) return sendError('Nu s-a primit ID job.');

            sendStatus('Job trimis, se generează...');

            let videoUrl;
            try {
                videoUrl = await pollWuyinResult(jobId, process.env.WUYIN_API_KEY, emailTag, sendStatus, abortController);
            } catch (pollErr) {
                if (pollErr.message === 'client_aborted') return;
                return sendError(pollErr.message);
            }

            if (clientAborted) return;

            await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });
            user.credits -= totalCost;
            await user.save();

            sendDone([videoUrl]);
        } catch (e) {
            console.error(`[Video] ❌ Eroare la ${elapsed()}: ${e.message}`);
            if (!clientAborted) sendError(e.message);
        }
    }
);

// ✅ Upload ref_images la R2 (pentru video)
const uploadImageToR2 = async (file, userId, prefix = 'refs') => {
    const ext = file.mimetype.split('/')[1] || 'jpg';
    const fileName = `${prefix}/vid_${userId}_${Date.now()}_${Math.random().toString(36).substring(5)}.${ext}`;
    return await uploadToR2(file.buffer, fileName, file.mimetype);
};

// ✅ Construiește multipart pentru frames-to-video
const buildVideoFormData = (params) => {
    const { prompt, videoRatio, count, startImageFile, endImageFile } = params;
    const fields = { prompt, aspect_ratio: videoRatio, number_of_videos: String(count) };
    const files = [];
    if (startImageFile) files.push({ fieldname: 'start_image', buffer: startImageFile.buffer, mimetype: startImageFile.mimetype, filename: startImageFile.originalname || 'start.jpg' });
    if (endImageFile)   files.push({ fieldname: 'end_image',   buffer: endImageFile.buffer,   mimetype: endImageFile.mimetype,   filename: endImageFile.originalname   || 'end.jpg' });
    return buildMultipartBody(fields, files);
};

// =========================================================================
// ==================== ALTE RUTE ==========================================
// =========================================================================
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const logs = await Log.find().sort({ createdAt: -1 }).limit(100);
        const totalImages = await Log.aggregate([{ $match: { type: 'image' } }, { $group: { _id: null, total: { $sum: "$count" } } }]);
        const totalVideos = await Log.aggregate([{ $match: { type: 'video' } }, { $group: { _id: null, total: { $sum: "$count" } } }]);
        res.json({ totalUsers, totalImages: totalImages[0]?.total || 0, totalVideos: totalVideos[0]?.total || 0, recentLogs: logs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/api-quota', authenticateAdmin, async (req, res) => {
    res.json({ balance: 0, veoTotal: 0, veoUsed: 0, veoAvail: 0 });
});

app.get('/api/media/history', authenticate, async (req, res) => {
    try {
        const type = req.query.type || 'image';
        const history = await History.find({ userId: req.userId, type }).sort({ createdAt: -1 }).limit(50);
        res.json({ history });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/media/save-history', authenticate, async (req, res) => {
    const { urls, type, prompt } = req.body;
    if (!urls || !urls.length) return res.status(400).json({ error: 'Fără URL-uri.' });
    try {
        for (const url of urls) await History.create({ userId: req.userId, type, originalUrl: url, supabaseUrl: url, prompt });
        res.status(200).json({ message: 'Istoric salvat cu succes' });
    } catch (err) {
        console.error('Eroare istoric MongoDB:', err.message);
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/media/proxy-download', authenticate, async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('Fetch failed');
        const buffer = await r.arrayBuffer();
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'viralio_media'}"`);
        res.send(Buffer.from(buffer));
    } catch(e) {
        res.status(500).json({ error: 'Nu s-a putut descărca fișierul.' });
    }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Adaugă asta chiar înainte de app.listen(), la finalul fișierului

process.on('uncaughtException', (err) => {
    console.error('❌ uncaughtException (server NU s-a oprit):', err.message);
    // Nu facem process.exit() — serverul continuă
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ unhandledRejection (server NU s-a oprit):', reason);
});
app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));