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

    // ✅ Set SSE headers FIRST so status updates stream live
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let clientAborted = false;
    res.on('close', () => { clientAborted = true; console.log(`[Imagini] ⚠️ Client a anulat | ${req.userId}`); });

    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = Math.min(parseInt(number_of_images) || 1, 4); // max 4
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (!user) { res.write(`data: ${JSON.stringify({ error: "User negăsit." })}\n\n`); res.end(); return; }
        if (user.credits < totalCost) { res.write(`data: ${JSON.stringify({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` })}\n\n`); res.end(); return; }

        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';

        console.log(`[Imagini] START | model=${MODEL_ID} count=${count} cost=${totalCost} | ${user.email}`);
        res.write(`data: ${JSON.stringify({ status: `Se pregătește generarea a ${count} imagini...` })}\n\n`);

        // ✅ Build parts once
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

        // ✅ Process each image request and upload immediately as it completes
        const urls = [];
        let completedCount = 0;

        // Run all N requests in parallel, each uploads independently
        const imagePromises = Array.from({ length: count }, async (_, idx) => {
            if (clientAborted) return;
            // Each request gets a unique seed
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
                                            return; // success, exit retry loop
                                        } catch (uploadErr) {
                                            console.error(`[Imagini] ❌ R2 upload eșuat: ${uploadErr.message}`);
                                        }
                                    }
                                }
                            }
                            // If candidate had no image (filtered), retry with different seed
                            const reason = candidate.finishReason;
                            if (reason && reason !== 'STOP') {
                                console.warn(`[Imagini] Imagine ${idx+1} filtrată (${reason}), reîncerc cu alt seed...`);
                                break; // break parts loop, retry outer while
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Imagini] Eroare imagine ${idx+1}, attempt ${attempts}: ${err.message}`);
                }
                // small delay before retry
                await new Promise(r => setTimeout(r, 1500));
            }
            console.warn(`[Imagini] ⚠️ Imagine ${idx+1} nu a putut fi generată după ${maxAttempts} încercări`);
        });

        await Promise.allSettled(imagePromises);

        if (clientAborted) return;

        if (urls.length === 0) {
            console.error(`[Imagini] ❌ 0 imagini generate`);
            res.write(`data: ${JSON.stringify({ error: "Imaginile nu au putut fi generate. Promptul poate conține elemente blocate de filtrul de siguranță — încearcă să îl modifici." })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Deduct only for successfully generated images
        await Log.create({ userEmail: user.email, type: 'image', count: urls.length, cost: urls.length * costPerImg });
        user.credits -= (urls.length * costPerImg);
        await user.save();
        console.log(`[Imagini] ✅ ${urls.length}/${count} imagini gata în ${elapsed()} | -${urls.length * costPerImg} cr | ${user.email}`);

        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (e) {
        console.error(`[Imagini] ❌ Eroare la ${elapsed()}: ${e.message}`);
        if (!clientAborted) {
            res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

// =========================================================================
// ==================== VIDEO ==============================================
// =========================================================================

const VIDEO_API_URL = 'https://genaipro.vn/api/v1';

const toVideoRatio = (ratio) => {
    const portrait = ['9:16', '4:5', '3:4', '2:3'];
    return portrait.includes(ratio) ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE';
};

const mapVideoError = (msg) => {
    if (!msg) return 'Eroare necunoscută la generarea video.';
    if (msg.includes('PUBLIC_ERROR_SEXUAL'))
        return '🚫 Conținutul solicitat a fost blocat: promptul conține elemente de natură sexuală sau inadecvată. Modifică descrierea și încearcă din nou.';
    if (msg.includes('UNSAFE_GENERATION') || msg.includes('unsafe') || msg.includes('PUBLIC_ERROR_DANGER_FILTER'))
        return '🚫 Conținutul solicitat a fost blocat de filtrul de siguranță. Modifică promptul și încearcă din nou.';
    if (msg.includes('AUDIO_FILTERED'))
        return '🚫 Audio-ul generat a fost filtrat — conține elemente inadecvate. Reformulează textul vorbit.';
    if (msg.includes('TIMED_OUT') || msg.includes('TIMEOUT') || msg.includes('PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT'))
        return 'Generarea a durat prea mult. Se reîncearcă automat...';
    if (msg.includes('quota') || msg.includes('QUOTA'))
        return 'Limita de generări a fost atinsă temporar. Reîncearcă în 1-2 minute.';
    if (msg.includes('Create video error') || msg.includes('Create video failed'))
        return 'Serverele AI au întâmpinat o eroare internă. Se reîncearcă automat...';
    return msg.replace(/genaipro/gi, 'serverul AI').replace(/GenAIPro/g, 'serverul AI');
};

const isContentBlockedError = (msg) => {
    if (!msg) return false;
    return (
        msg.includes('PUBLIC_ERROR_DANGER_FILTER') ||
        msg.includes('UNSAFE_GENERATION') ||
        msg.includes('AUDIO_FILTERED') ||
        msg.includes('PUBLIC_ERROR_SEXUAL')
    );
};

const parseVideoSSE = (apiRes, emailTag, onStatus) => {
    return new Promise((resolve, reject) => {
        const reader = apiRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let currentEvent = '';
        let lastLoggedStatus = '';
        let settled = false;

        const globalTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            console.warn(`[Video] ⏰ Timeout global 360s | ${emailTag}`);
            try { reader.cancel(); } catch (_) {}
            reject(new Error('PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT'));
        }, 360000);

        let activityTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            console.warn(`[Video] ⏰ Timeout inactivitate 120s | ${emailTag}`);
            clearTimeout(globalTimeout);
            try { reader.cancel(); } catch (_) {}
            reject(new Error('PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT'));
        }, 180000);

        const resetActivity = () => {
            clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.warn(`[Video] ⏰ Timeout inactivitate 120s | ${emailTag}`);
                clearTimeout(globalTimeout);
                try { reader.cancel(); } catch (_) {}
                reject(new Error('PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT'));
            }, 180000);
        };

        const done = (urls) => {
            if (settled) return;
            settled = true;
            clearTimeout(globalTimeout);
            clearTimeout(activityTimeout);
            resolve(urls);
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(globalTimeout);
            clearTimeout(activityTimeout);
            try { reader.cancel(); } catch (_) {}
            reject(err);
        };

const pump = async () => {
    try {
        while (true) {
            let result;
            try {
                result = await reader.read();
            } catch (readErr) {
                // UND_ERR_SOCKET, terminated, other side closed — all treated as stream end
                if (!settled) fail(new Error('terminated'));
                return;
            }

            if (!result) { if (!settled) fail(new Error('terminated')); return; }

            const { done: streamDone, value } = result;
            if (streamDone) break;

                    buf += dec.decode(value, { stream: true });
                    resetActivity();
                    const lines = buf.split('\n');
                    buf = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) { currentEvent = ''; continue; }

                        if (trimmed.startsWith('event:')) {
                            currentEvent = trimmed.slice(6).trim();
                            continue;
                        }

                        if (!trimmed.startsWith('data:')) continue;
                        const raw = trimmed.slice(5).trim();

                        if (currentEvent && currentEvent !== 'video_generation_status') {
                            console.log(`[Video] RAW event="${currentEvent}" data="${raw.substring(0, 300)}" | ${emailTag}`);
                        }

                        if (currentEvent === 'video_generation_status') {
                            if (raw !== lastLoggedStatus) {
                                console.log(`[Video] Status → ${raw} | ${emailTag}`);
                                lastLoggedStatus = raw;
                                if (onStatus) onStatus(raw);
                            }
                            continue;
                        }

                        if (currentEvent === 'error') {
                            let rawMsg = raw;
                            try {
                                const errObj = JSON.parse(raw);
                                rawMsg = errObj.error || errObj.message || raw;
                            } catch (_) {}
                            console.error(`[Video] ❌ Server error: ${rawMsg} | ${emailTag}`);
                            return fail(new Error(rawMsg));
                        }

                        if (currentEvent === 'video_generation_complete') {
                            console.log(`[Video] ✅ Complet! | ${emailTag}`);
                            try {
                                const parsed = JSON.parse(raw);
                                const items = Array.isArray(parsed) ? parsed : [parsed];
                                const urls = [];
                                items.forEach(item => {
                                    if (item.file_url)  urls.push(item.file_url);
                                    if (item.video_url) urls.push(item.video_url);
                                    if (item.url)       urls.push(item.url);
                                    if (Array.isArray(item.file_urls)) urls.push(...item.file_urls);
                                });
                                if (urls.length > 0) return done(urls);
                            } catch (_) {}
                        }

                        if (raw.startsWith('{') || raw.startsWith('[')) {
                            try {
                                const obj = JSON.parse(raw);
                                const urls = [];
                                if (obj.file_url)  urls.push(obj.file_url);
                                if (obj.video_url) urls.push(obj.video_url);
                                if (obj.url)       urls.push(obj.url);
                                if (Array.isArray(obj.file_urls)) urls.push(...obj.file_urls);
                                if (urls.length > 0) return done(urls);
                                if (obj.error) return fail(new Error(obj.error));
                            } catch (_) {}
                        }
                    }
                }
                if (!settled) fail(new Error('Stream închis fără rezultat'));
            } catch (e) {
                if (!settled) fail(e);
            }
        };

        pump().catch(err => { if (!settled) fail(err); });
    });
};

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
        res.on('close', () => {
            if (!res.writableEnded) {
                clientAborted = true;
                console.log(`[Video] ⚠️ Client a anulat | ${req.userId}`);
            }
        });

        const sendStatus = (status) => {
            if (!res.writableEnded && !clientAborted) res.write(`data: ${JSON.stringify({ status })}\n\n`);
        };
        const sendDone = (urls) => {
            if (!res.writableEnded && !clientAborted) {
                res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        };
        const sendError = (msg) => {
            if (!res.writableEnded && !clientAborted) {
                res.write(`data: ${JSON.stringify({ error: mapVideoError(msg) })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        };

        try {
            const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
            let finalPrompt = prompt;
            const count = parseInt(number_of_videos) || 1;
            const costPerVid = MODEL_PRICES[model_id] || 3;
            const totalCost = count * costPerVid;
            const videoRatio = toVideoRatio(aspect_ratio);

            const user = await User.findById(req.userId);
            if (!user) return sendError('User negăsit.');
            if (user.credits < totalCost) return sendError(`Fonduri insuficiente! Ai nevoie de ${totalCost} credite.`);

            const startImageFile = req.files?.['start_image']?.[0] || null;
            const endImageFile   = req.files?.['end_image']?.[0]   || null;
            const refImages      = req.files?.['ref_images']        || [];

            const hasFrames = startImageFile || endImageFile;

            // ✅ Upload ref_images la R2 și înlocuiește tag-urile @img1, @img2...
            if (refImages.length > 0) {
                for (let i = 0; i < refImages.length; i++) {
                    const url = await uploadImageToR2(refImages[i], req.userId, 'refs');
                    const tag = `@img${i + 1}`;
                    if (finalPrompt.includes(tag)) {
                        finalPrompt = finalPrompt.replace(new RegExp(tag, 'g'), url);
                    }
                }
            }

const buildRequest = async () => {
    if (hasFrames) {
        const fields = {
            prompt: finalPrompt,
            aspect_ratio: videoRatio,
            number_of_videos: String(count)
        };
        const files = [];
        if (startImageFile) {
            const { buffer, mimetype } = await compressForVideo(startImageFile.buffer, startImageFile.mimetype);
            files.push({ fieldname: 'start_image', buffer, mimetype, filename: 'start.jpg' });
        }
        if (endImageFile) {
            const { buffer, mimetype } = await compressForVideo(endImageFile.buffer, endImageFile.mimetype);
            files.push({ fieldname: 'end_image', buffer, mimetype, filename: 'end.jpg' });
        }

        console.log(`[Video] Multipart files: ${files.map(f => f.fieldname + '=' + f.buffer.length + 'bytes').join(', ')}`);

        const { body: formBody, contentType } = buildMultipartBody(fields, files);
        return {
            endpoint: `${VIDEO_API_URL}/veo/frames-to-video`,
            options: {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}`,
                    'Content-Type': contentType
                },
                body: formBody
            }
        };
    }
    return {
        endpoint: `${VIDEO_API_URL}/veo/text-to-video`,
        options: {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prompt: finalPrompt, aspect_ratio: videoRatio, number_of_videos: count })
        }
    };
};

            const MAX_VIDEO_RETRIES = 3;
            const RETRY_DELAY_MS = 4000;
            let videoUrls = null;
            let lastErrorMsg = null;
            const emailTag = user.email;
            const type = hasFrames ? 'frames-to-video' : 'text-to-video';

            for (let attempt = 1; attempt <= MAX_VIDEO_RETRIES; attempt++) {
                const { endpoint, options } = await buildRequest();
                console.log(`[Video] Tentativa ${attempt}/${MAX_VIDEO_RETRIES} | ${type} | ratio=${videoRatio} count=${count} | ${emailTag}`);
                sendStatus(`Se generează... (încercare ${attempt}/${MAX_VIDEO_RETRIES})`);

                let apiRes;
                try {
                    apiRes = await fetch(endpoint, options);
                } catch (fetchErr) {
                    console.warn(`[Video] Fetch network error: ${fetchErr.message} | ${emailTag}`);
                    lastErrorMsg = fetchErr.message;
                    if (attempt < MAX_VIDEO_RETRIES) {
                        sendStatus(`Eroare de rețea, reîncerc...`);
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                        continue;
                    }
                    break;
                }

                if (!apiRes.ok) {
                    const errorDetails = await apiRes.text().catch(() => '');
                    console.error(`[Video] HTTP ${apiRes.status}: ${errorDetails.substring(0, 300)} | ${emailTag}`);
                    lastErrorMsg = `HTTP ${apiRes.status}: ${errorDetails.substring(0, 100)}`;
                    if ((apiRes.status === 429 || apiRes.status === 503) && attempt < MAX_VIDEO_RETRIES) {
                        sendStatus('Server suprasolicitat, reîncerc...');
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                        continue;
                    }
                    break;
                }

                try {
                    videoUrls = await parseVideoSSE(apiRes, emailTag, (s) => sendStatus(`${s}...`));
                    console.log(`[Video] ✅ Done în ${elapsed()} | ${emailTag}`);
                    break;
                } catch (sseErr) {
                    lastErrorMsg = sseErr.message || 'Eroare SSE';
                    const isSocketError = lastErrorMsg === 'terminated' || lastErrorMsg.includes('UND_ERR') || lastErrorMsg.includes('socket');
                    console.log(`[Video] Tentativa ${attempt} eșuată | ${isSocketError ? 'conexiune întreruptă' : lastErrorMsg} | ${emailTag}`);

                    if (isContentBlockedError(lastErrorMsg)) {
                        console.log(`[Video] ❌ Conținut blocat — nu reîncercăm. | ${emailTag}`);
                        break;
                    }

                    if (attempt < MAX_VIDEO_RETRIES) {
                        const retryDelay = isSocketError ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
                        console.log(`[Video] Reîncerc în ${retryDelay}ms... (${attempt + 1}/${MAX_VIDEO_RETRIES}) | ${emailTag}`);
                        sendStatus(`Conexiune întreruptă, reîncerc... (${attempt + 1}/${MAX_VIDEO_RETRIES})`);
                        await new Promise(r => setTimeout(r, retryDelay));
                    }
                }
            }

            if (videoUrls && videoUrls.length > 0) {
                await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });
                user.credits -= totalCost;
                await user.save();
                console.log(`[Video] Credite scăzute: -${totalCost} | ${emailTag}`);
                sendDone(videoUrls);
            } else {
                console.log(`[Video] Creditele NU se scad (niciun video generat). | ${emailTag}`);
                sendError(lastErrorMsg || 'Generarea video a eșuat după toate încercările. Te rugăm să reîncerci.');
            }

        } catch (e) {
            console.error(`[Video] ❌ Eroare neașteptată la ${elapsed()}: ${e.message}`);
            sendError(e.message);
        }
    }
);

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
        const page = parseInt(req.query.page) || 1;
        const limit = 80;
        const skip = (page - 1) * limit;
        const history = await History.find({ userId: req.userId, type })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
        const total = await History.countDocuments({ userId: req.userId, type });
        res.json({ history, total, page, pages: Math.ceil(total / limit) });
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