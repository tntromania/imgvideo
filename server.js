require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3001;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── MULTER — limită 20MB per fișier, max 5 fișiere ─────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 }
});

// ─── BODY SIZE LIMIT ─────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── MONGODB ──────────────────────────────────────────────────────────────────
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

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
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

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
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

// ─── MODEL PRICES ─────────────────────────────────────────────────────────────
const MODEL_PRICES = {
    'gemini-flash': 1, 'nano-banana-pro-1k': 1,
    'gemini-pro': 2,   'nano-banana-pro-2k': 2,
    'veo3.1': 3,       'veo3.1fast': 2,
};

// ─── FETCH WITH RETRY ─────────────────────────────────────────────────────────
const fetchWithRetry = async (url, options, maxRetries = 6, delayMs = 5000) => {
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
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
            if (error.name === 'AbortError') throw new Error("Timpul de așteptare a expirat. Te rugăm să încerci din nou.");
            if (i < maxRetries - 1) {
                console.warn(`[Network] Eroare conexiune, reîncerc în ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 2;
            } else throw error;
        }
    }
    throw new Error("Sistemul AI este suprasolicitat. Te rugăm să încerci din nou în câteva secunde.");
};

// ─── IMAGE QUEUE ──────────────────────────────────────────────────────────────
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

    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_images) || 1;
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (!user) return res.status(401).json({ error: "User negăsit." });
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';

        console.log(`[Imagini] START | model=${MODEL_ID} count=${count} cost=${totalCost} | ${user.email}`);

        let parts = [];
        if (req.files && req.files.length > 0) {
            console.log(`[Imagini] ${req.files.length} imagini referință primite`);
            for (let i = 0; i < req.files.length; i++) {
                parts.push({ inlineData: { mimeType: req.files[i].mimetype, data: req.files[i].buffer.toString('base64') } });
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt += `\n\n[Instruction: Use the provided images as exact character and style references. Aspect Ratio: ${aspect_ratio}]`;
        } else {
            finalPrompt += `\n\n[Instruction: Aspect Ratio: ${aspect_ratio}]`;
        }
        parts.push({ text: finalPrompt });

        let requestBody = {
            contents: [{ role: "user", parts }],
            generationConfig: { candidateCount: count }
        };

        if (isFlash) {
            requestBody.generationConfig.responseModalities = ["IMAGE"];
            requestBody.generationConfig.imageConfig = { aspectRatio: aspect_ratio || "1:1", imageSize: "1K" };
            requestBody.safetySettings = [
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
            ];
        }

        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${process.env.VERTEX_API_KEY}`;
        const fetchOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) };

        console.log(`[Imagini] Trimit la Vertex AI... (queue: ${imageQueue.length} în așteptare)`);
        const apiRes = await enqueueImageRequest(() => fetchWithRetry(endpoint, fetchOptions));
        console.log(`[Imagini] Răspuns Vertex AI primit la ${elapsed()}`);

        const rawText = await apiRes.text();
        let data;
        try { data = JSON.parse(rawText); }
        catch (err) {
            console.error(`[Imagini] JSON invalid de la Vertex: ${rawText.substring(0, 200)}`);
            throw new Error(`Sistemul AI a returnat un răspuns invalid. Te rugăm să reîncerci.`);
        }

        if (!apiRes.ok) {
            console.error(`[Imagini] Vertex error: ${data.error?.message}`);
            throw new Error(`Eroare la generarea imaginii: ${data.error?.message || 'Eroare necunoscută.'}`);
        }

        let urls = [];
        const finishReasons = [];

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

                            console.log(`[Imagini] Upload Supabase: ${fileName}`);
                            const { error: supaErr } = await supabase.storage
                                .from('media-history')
                                .upload(fileName, buffer, { contentType: mime });

                            if (supaErr) {
                                console.error(`[Imagini] ❌ Supabase upload eșuat: ${supaErr.message}`);
                            } else {
                                const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                                urls.push(publicData.publicUrl);
                                console.log(`[Imagini] ✅ Upload OK: ${publicData.publicUrl}`);
                            }
                        }
                    }
                }
            }
        }

        if (urls.length === 0) {
            console.error(`[Imagini] ❌ 0 imagini returnate. finishReasons: [${finishReasons.join(', ')}]`);
            console.error(`[Imagini] Raw response (primii 500 chars): ${rawText.substring(0, 500)}`);
            throw new Error("Imaginea nu a putut fi generată. Promptul poate conține elemente blocate de filtrul de siguranță — încearcă să îl modifici.");
        }

        await Log.create({ userEmail: user.email, type: 'image', count: urls.length, cost: urls.length * costPerImg });
        user.credits -= (urls.length * costPerImg);
        await user.save();
        console.log(`[Imagini] ✅ ${urls.length}/${count} imagini gata în ${elapsed()} | -${urls.length * costPerImg} cr | ${user.email}`);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (e) {
        console.error(`[Imagini] ❌ Eroare la ${elapsed()}: ${e.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        }
    }
});


// =========================================================================
// ==================== VIDEO (FIX COMPLET) ================================
// =========================================================================
// PROBLEMĂ ORIGINALĂ:
//   readVideoSSE() închidea res (res.end()) înăuntrul său, deci retry-ul
//   rula după ce browserul primise deja [DONE] — inutil.
//   SOLUȚIE: parseVideoSSE() doar parsează și returnează URL-urile (sau throw).
//   Route handler-ul deschide SSE imediat, face retry în loop curat,
//   apoi trimite rezultatul o singură dată la final.
// =========================================================================

const VIDEO_API_URL = 'https://genaipro.vn/api/v1';

const toVideoRatio = (ratio) => {
    const portrait = ['9:16', '4:5', '3:4', '2:3'];
    return portrait.includes(ratio) ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE';
};

const mapVideoError = (msg) => {
    if (!msg) return 'Eroare necunoscută la generarea video.';
    if (msg.includes('UNSAFE_GENERATION') || msg.includes('unsafe') || msg.includes('PUBLIC_ERROR_DANGER_FILTER'))
        return 'Conținutul solicitat nu poate fi generat — promptul conține elemente considerate nesigure. Te rugăm să modifici promptul.';
    if (msg.includes('AUDIO_FILTERED'))
        return 'Audio-ul generat a fost filtrat — promptul conține cuvinte nepermise în voiceover. Încearcă să reformulezi textul vorbit.';
    if (msg.includes('TIMED_OUT') || msg.includes('TIMEOUT'))
        return 'Generarea a durat prea mult. Te rugăm să reîncerci — de obicei reușește din a doua încercare.';
    if (msg.includes('quota') || msg.includes('QUOTA'))
        return 'Limita de generări a fost atinsă temporar. Reîncearcă în 1-2 minute.';
    if (msg.includes('Create video error') || msg.includes('Create video failed'))
        return 'Serverele AI au întâmpinat o eroare internă. Te rugăm să reîncerci.';
    return msg.replace(/genaipro/gi, 'serverul AI').replace(/GenAIPro/g, 'serverul AI');
};

// Parsează stream-ul SSE și returnează { urls, statusUpdates } sau aruncă eroare.
// NU atinge `res` — doar citește și parsează.
const parseVideoSSE = (apiRes) => {
    return new Promise((resolve, reject) => {
        const reader = apiRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let currentEvent = '';
        let lastLoggedStatus = '';
        const statusUpdates = [];

        const pump = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) { currentEvent = ''; continue; }

                        if (trimmed.startsWith('event:')) {
                            currentEvent = trimmed.slice(6).trim();
                            continue;
                        }

                        if (trimmed.startsWith('data:')) {
                            const raw = trimmed.slice(5).trim();

                            if (currentEvent === 'video_generation_status') {
                                if (raw !== lastLoggedStatus) {
                                    console.log(`[Video] Status → ${raw}`);
                                    lastLoggedStatus = raw;
                                }
                                statusUpdates.push(raw);
                                continue;
                            }

                            if (currentEvent === 'error') {
                                try {
                                    const errObj = JSON.parse(raw);
                                    const rawMsg = errObj.error || errObj.message || `Eroare (cod: ${errObj.code || 'necunoscut'})`;
                                    console.error(`[Video] ❌ Server error: ${rawMsg}`);
                                    return reject(new Error(rawMsg));
                                } catch {
                                    return reject(new Error(raw));
                                }
                            }

                            if (currentEvent === 'video_generation_complete') {
                                console.log(`[Video] ✅ Complet!`);
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
                                    if (urls.length > 0) return resolve({ urls, statusUpdates });
                                } catch { /* ignorăm */ }
                            }

                            if (raw.startsWith('{') || raw.startsWith('[')) {
                                try {
                                    const obj = JSON.parse(raw);
                                    const urls = [];
                                    if (obj.file_url)  urls.push(obj.file_url);
                                    if (obj.video_url) urls.push(obj.video_url);
                                    if (obj.url)       urls.push(obj.url);
                                    if (Array.isArray(obj.file_urls)) urls.push(...obj.file_urls);
                                    if (urls.length > 0) return resolve({ urls, statusUpdates });
                                    if (obj.error) return reject(new Error(obj.error));
                                } catch { /* ignorăm liniile ne-JSON */ }
                            }
                        }
                    }
                }
                reject(new Error('Generarea video nu a returnat niciun rezultat.'));
            } catch (e) {
                reject(e);
            }
        };

        pump();
    });
};

app.post('/api/media/video', authenticate, upload.array('ref_images', 5), async (req, res) => {
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    // Deschidem SSE imediat ca browserul să nu time-out-eze în așteptare
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendStatus = (status) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ status })}\n\n`);
    };
    const sendDone = (urls) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    };
    const sendError = (msg) => {
        if (!res.writableEnded) {
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
        const video_ratio = toVideoRatio(aspect_ratio);

        const user = await User.findById(req.userId);
        if (!user) return sendError('User negăsit.');
        if (user.credits < totalCost) return sendError(`Fonduri insuficiente! Ai nevoie de ${totalCost} credite.`);

        let startImageFile = null;
        if (req.files && req.files.length > 0) {
            startImageFile = req.files[0];
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                const fileName = `refs/vid_${req.userId}_${Date.now()}_${i}.png`;
                const { error } = await supabase.storage.from('media-history').upload(fileName, file.buffer, { contentType: file.mimetype });
                if (!error) {
                    const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                    const tag = `@img${i + 1}`;
                    if (finalPrompt.includes(tag)) finalPrompt = finalPrompt.replace(new RegExp(tag, 'g'), publicData.publicUrl);
                }
            }
        }

        const buildFetchOptions = () => {
            if (startImageFile) {
                const formData = new FormData();
                formData.append('prompt', finalPrompt);
                formData.append('aspect_ratio', video_ratio);
                formData.append('number_of_videos', String(count));
                formData.append('start_image', new Blob([startImageFile.buffer], { type: startImageFile.mimetype }), startImageFile.originalname);
                return {
                    endpoint: `${VIDEO_API_URL}/veo/frames-to-video`,
                    options: { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` }, body: formData }
                };
            }
            return {
                endpoint: `${VIDEO_API_URL}/veo/text-to-video`,
                options: {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: finalPrompt, aspect_ratio: video_ratio, number_of_videos: count })
                }
            };
        };

        const MAX_VIDEO_RETRIES = 5;
        const RETRY_DELAY_MS = 3000;
        let videoUrls = null;
        let lastErrorMsg = null;

        for (let attempt = 1; attempt <= MAX_VIDEO_RETRIES; attempt++) {
            const { endpoint, options } = buildFetchOptions();
            const type = startImageFile ? 'frames-to-video' : 'text-to-video';
            console.log(`[Video] Tentativa ${attempt}/${MAX_VIDEO_RETRIES} | ${type} | ratio=${video_ratio} count=${count} | ${user.email}`);
            sendStatus(`Se generează... (încercare ${attempt}/${MAX_VIDEO_RETRIES})`);

            let apiRes;
            try {
                apiRes = await fetch(endpoint, options);
            } catch (fetchErr) {
                console.warn(`[Video] Fetch network error: ${fetchErr.message}`);
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
                console.error(`[Video] HTTP ${apiRes.status}: ${errorDetails.substring(0, 300)}`);
                lastErrorMsg = `HTTP ${apiRes.status}`;
                if ((apiRes.status === 429 || apiRes.status === 503) && attempt < MAX_VIDEO_RETRIES) {
                    console.log(`[Video] Rate limited, reîncerc în ${RETRY_DELAY_MS}ms...`);
                    sendStatus('Server suprasolicitat, reîncerc...');
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    continue;
                }
                break;
            }

            try {
                const { urls, statusUpdates } = await parseVideoSSE(apiRes);

                // Trimitem statusurile colectate live la client
                for (const s of statusUpdates) sendStatus(s);

                videoUrls = urls;
                console.log(`[Video] ✅ Done în ${elapsed()} | ${user.email}`);
                break; // succes — ieșim din loop

            } catch (sseErr) {
                lastErrorMsg = sseErr.message || 'Eroare SSE';
                console.log(`[Video] Tentativa ${attempt} eșuată | ${lastErrorMsg}`);

                // Nu reîncercăm erori de conținut (filtru de siguranță)
                const isContentBlocked =
                    lastErrorMsg.includes('PUBLIC_ERROR_DANGER_FILTER') ||
                    lastErrorMsg.includes('UNSAFE_GENERATION') ||
                    lastErrorMsg.includes('AUDIO_FILTERED');

                if (isContentBlocked) {
                    console.log(`[Video] ❌ Conținut blocat — nu reîncercăm.`);
                    break;
                }

                if (attempt < MAX_VIDEO_RETRIES) {
                    console.log(`[Video] Reîncerc în ${RETRY_DELAY_MS}ms... (${attempt + 1}/${MAX_VIDEO_RETRIES})`);
                    sendStatus(`Reîncerc... (${attempt + 1}/${MAX_VIDEO_RETRIES})`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }
        }

        // ── Rezultat final ───────────────────────────────────────────────────
        if (videoUrls && videoUrls.length > 0) {
            // Taxăm DOAR dacă am primit URL-uri reale
            await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });
            user.credits -= totalCost;
            await user.save();
            console.log(`[Video] Credite scăzute: -${totalCost} | ${user.email}`);
            sendDone(videoUrls);
        } else {
            console.log(`[Video] Creditele NU se scad (niciun video generat).`);
            sendError(lastErrorMsg || 'Generarea video a eșuat după toate încercările. Te rugăm să reîncerci.');
        }

    } catch (e) {
        console.error(`[Video] ❌ Eroare neașteptată la ${elapsed()}: ${e.message}`);
        sendError(e.message);
    }
});


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
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));