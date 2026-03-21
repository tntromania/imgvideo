require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3001;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Media Studio conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    name: String,
    picture: String,
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
    originalUrl: String,
    supabaseUrl: String,
    prompt: String,
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
            req.userId = decoded.userId;
            next();
        } else {
            res.status(403).json({ error: "Ai greșit contul?" });
        }
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

const MODEL_PRICES = {
    'gemini-flash': 1,
    'nano-banana-pro-1k': 1,
    'gemini-pro': 2,
    'nano-banana-pro-2k': 2,
    'veo3.1': 3,
    'veo3.1fast': 2,
};

// --- SISTEM ANTI-Aglomerare ---
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
                console.warn(`[AI] Sistem aglomerat (Eroare ${response.status}). Încercarea ${i + 1}/${maxRetries}. Reîncerc în ${delayMs}ms...`);
                await new Promise(res => setTimeout(res, delayMs));
                delayMs *= 2;
                continue;
            } else {
                throw new Error(text);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error("Timpul de așteptare a expirat. Te rugăm să încerci din nou.");
            if (i < maxRetries - 1) {
                console.warn(`[Network] Eroare la conexiune. Reîncerc în ${delayMs}ms...`);
                await new Promise(res => setTimeout(res, delayMs));
                delayMs *= 2;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Sistemul AI este suprasolicitat de prea mulți utilizatori. Te rugăm să încerci din nou în câteva secunde.");
};

// Queue simplu — max 1 cerere simultana
let imageQueueRunning = false;
const imageQueue = [];

const enqueueImageRequest = (fn) => {
    return new Promise((resolve, reject) => {
        imageQueue.push({ fn, resolve, reject });
        processImageQueue();
    });
};

const processImageQueue = async () => {
    if (imageQueueRunning || imageQueue.length === 0) return;
    imageQueueRunning = true;
    const { fn, resolve, reject } = imageQueue.shift();
    try { resolve(await fn()); } 
    catch (e) { reject(e); } 
    finally {
        imageQueueRunning = false;
        setTimeout(processImageQueue, 2000);
    }
};

// =========================================================================
// ==================== IMAGINI ============================================
// =========================================================================
app.post('/api/media/image', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_images) || 1;
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        let parts = [];

        if (req.files && req.files.length > 0) {
            for (let i = 0; i < req.files.length; i++) {
                parts.push({
                    inlineData: {
                        mimeType: req.files[i].mimetype,
                        data: req.files[i].buffer.toString('base64')
                    }
                });
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt = finalPrompt + `\n\n[Instruction: Use the provided images as exact character and style references. Aspect Ratio: ${aspect_ratio}]`;
        } else {
            finalPrompt = finalPrompt + `\n\n[Instruction: Aspect Ratio: ${aspect_ratio}]`;
        }

        parts.push({ text: finalPrompt });

        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';

        let requestBody = {
            contents: [{ role: "user", parts: parts }],
            generationConfig: { candidateCount: count }
        };

        if (isFlash) {
            requestBody.generationConfig.responseModalities = ["IMAGE"];
            requestBody.generationConfig.imageConfig = {
                aspectRatio: aspect_ratio || "1:1",
                imageSize: "1K"
            };
            requestBody.safetySettings = [
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
            ];
        }

        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${process.env.VERTEX_API_KEY}`;
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        };

        const apiRes = await enqueueImageRequest(() => fetchWithRetry(endpoint, fetchOptions));
        const rawText = await apiRes.text();

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (err) {
            throw new Error(`Sistemul AI a returnat un răspuns invalid. Te rugăm să reîncerci.`);
        }

        if (!apiRes.ok) {
            throw new Error(`Eroare la generarea imaginii: ${data.error?.message || 'Eroare necunoscută.'}`);
        }

        let urls = [];
        if (data.candidates) {
            for (const candidate of data.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData && part.inlineData.data) {
                            const b64 = part.inlineData.data;
                            const mime = part.inlineData.mimeType || 'image/png';
                            const ext = mime.split('/')[1] || 'png';
                            const buffer = Buffer.from(b64, 'base64');
                            const fileName = `generated/${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                            const { error: supaErr } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: mime });
                            if (!supaErr) {
                                const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                                urls.push(publicData.publicUrl);
                            }
                        }
                    }
                }
            }
        }

        if (urls.length === 0) throw new Error("Imaginea nu a putut fi generată. Promptul poate conține elemente blocate de filtrul de siguranță — încearcă să îl modifici.");

        await Log.create({ userEmail: user.email, type: 'image', count: urls.length, cost: urls.length * costPerImg });
        user.credits -= (urls.length * costPerImg);
        await user.save();

        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        console.error("Eroare Rută Imagini:", e);
        res.status(500).json({ error: e.message });
    }
});


// =========================================================================
// ==================== VIDEO ==============================================
// =========================================================================

const VIDEO_API_URL = 'https://genaipro.vn/api/v1';

const toGenAIProRatio = (ratio) => {
    const portrait = ['9:16', '4:5', '3:4', '2:3'];
    return portrait.includes(ratio) ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'VIDEO_ASPECT_RATIO_LANDSCAPE';
};

const mapVideoError = (msg) => {
    if (!msg) return 'Eroare necunoscută la generarea video.';
    if (msg.includes('UNSAFE_GENERATION') || msg.includes('unsafe'))
        return 'Conținutul solicitat nu poate fi generat — promptul conține elemente considerate nesigure sau inadecvate. Te rugăm să modifici promptul.';
    if (msg.includes('AUDIO_FILTERED') || msg.includes('audio'))
        return 'Audio-ul generat a fost filtrat automat — promptul conține cuvinte sau fraze nepermise în voiceover.';
    if (msg.includes('500') || msg.includes('Create video error') || msg.includes('Create video failed'))
        return 'Serverele AI sunt momentan suprasolicitate. Te rugăm să reîncerci în câteva secunde.';
    if (msg.includes('quota') || msg.includes('QUOTA'))
        return 'Limita de generări a fost atinsă temporar. Reîncearcă în 1-2 minute.';
    // Ascundem numele serviciului intern din orice alt mesaj
    return msg.replace(/genaipro/gi, 'serverul AI').replace(/GenAIPro/g, 'serverul AI');
};

const readVideoSSE = (apiRes, res) => {
    return new Promise((resolve, reject) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = apiRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let currentEvent = '';
        let resolved = false;

        const finish = (urls) => {
            if (resolved) return;
            resolved = true;
            res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            resolve(urls);
        };

        const fail = (msg) => {
            if (resolved) return;
            resolved = true;
            res.write(`data: ${JSON.stringify({ error: mapVideoError(msg) })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            reject(new Error(mapVideoError(msg)));
        };

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
                            console.log(`[Video SSE] event: ${currentEvent}`);
                            continue;
                        }

                        if (trimmed.startsWith('data:')) {
                            const raw = trimmed.slice(5).trim();
                            console.log(`[Video SSE] data (event=${currentEvent}): ${raw.substring(0, 120)}`);

                            if (currentEvent === 'video_generation_status') {
                                res.write(`data: ${JSON.stringify({ status: raw })}\n\n`);
                                continue;
                            }

                            if (currentEvent === 'error') {
                                try {
                                    const errObj = JSON.parse(raw);
                                    const rawMsg = errObj.error || errObj.message || `Eroare la generare (cod: ${errObj.code || 'necunoscut'})`;
                                    fail(rawMsg);
                                } catch {
                                    fail(raw);
                                }
                                return;
                            }

                            if (currentEvent === 'video_generation_complete') {
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
                                    if (urls.length > 0) { finish(urls); return; }
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

                                    if (urls.length > 0) { finish(urls); return; }

                                    if (obj.error) { fail(obj.error); return; }
                                } catch { /* ignorăm liniile ne-JSON */ }
                            }
                        }
                    }
                }

                if (!resolved) fail('Generarea video nu a returnat niciun rezultat. Te rugăm să reîncerci.');
            } catch (e) {
                if (!resolved) fail(`Eroare la citirea răspunsului: ${e.message}`);
            }
        };

        pump();
    });
};

app.post('/api/media/video', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_videos) || 1;
        const costPerVid = MODEL_PRICES[model_id] || 3;
        const totalCost = count * costPerVid;
        const genaipro_ratio = toGenAIProRatio(aspect_ratio);

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

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
                    if (finalPrompt.includes(tag)) {
                        finalPrompt = finalPrompt.replace(new RegExp(tag, 'g'), publicData.publicUrl);
                    }
                }
            }
        }

        let endpoint, fetchOptions;

        if (startImageFile) {
            endpoint = `${VIDEO_API_URL}/veo/frames-to-video`;
            const formData = new FormData();
            formData.append('prompt', finalPrompt);
            formData.append('aspect_ratio', genaipro_ratio);
            formData.append('number_of_videos', String(count));
            const blob = new Blob([startImageFile.buffer], { type: startImageFile.mimetype });
            formData.append('start_image', blob, startImageFile.originalname);

            fetchOptions = {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` },
                body: formData
            };
        } else {
            endpoint = `${VIDEO_API_URL}/veo/text-to-video`;
            fetchOptions = {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt: finalPrompt,
                    aspect_ratio: genaipro_ratio,
                    number_of_videos: count
                })
            };
        }

        console.log(`[Video] endpoint=${endpoint} ratio=${genaipro_ratio} count=${count}`);

        const apiRes = await fetch(endpoint, fetchOptions);

        if (!apiRes.ok) {
            const errorDetails = await apiRes.text();
            // Ascundem detaliile tehnice — logăm intern, afișăm mesaj generic
            console.error(`[Video] HTTP ${apiRes.status}: ${errorDetails}`);
            throw new Error(`Serverele AI au returnat o eroare (${apiRes.status}). Te rugăm să reîncerci.`);
        }

        // Taxăm DOAR dacă generarea a reușit
        let videoUrls = [];
        try {
            videoUrls = await readVideoSSE(apiRes, res);
        } catch (sseErr) {
            console.log('[Video] SSE eșuat, creditele NU se scad:', sseErr.message);
            return;
        }

        if (videoUrls && videoUrls.length > 0) {
            await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });
            user.credits -= totalCost;
            await user.save();
            console.log(`[Video] Credite scăzute: -${totalCost} pentru ${user.email}`);
        }

    } catch (e) {
        console.error('[Video] Eroare:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        }
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
        const history = await History.find({ userId: req.userId, type: type }).sort({ createdAt: -1 }).limit(50);
        res.json({ history });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/media/save-history', authenticate, async (req, res) => {
    const { urls, type, prompt } = req.body;
    if (!urls || !urls.length) return res.status(400).json({ error: 'Fără URL-uri.' });
    try {
        for (const url of urls) {
            await History.create({
                userId: req.userId,
                type: type,
                originalUrl: url,
                supabaseUrl: url,
                prompt: prompt
            });
        }
        res.status(200).json({ message: 'Istoric salvat cu succes' });
    } catch (err) {
        console.error('Eroare la salvarea istoricului în MongoDB:', err.message);
        res.status(500).json({ error: 'Eroare server' });
    }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));