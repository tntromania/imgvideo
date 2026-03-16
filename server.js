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
    } catch (error) { res.status(400).json({ error: "Eroare Google" }); }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user });
});

const MODEL_PRICES = {
    'gemini-flash': 1,
    'gemini-pro': 2,
    'veo3.1': 5,
    'veo3.1fast': 3,
};

// --- SISTEM ANTI-Aglomerare Google ---
const fetchWithRetry = async (url, options, maxRetries = 4, delayMs = 1500) => {
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 
        
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) return response;

            const text = await response.text();
            
            if (response.status === 429 || response.status === 503 || text.toLowerCase().includes('exhausted')) {
                console.warn(`[Vertex AI] Sistem aglomerat (Eroare ${response.status}). Încercarea ${i + 1}/${maxRetries}. Reîncerc în ${delayMs}ms...`);
                await new Promise(res => setTimeout(res, delayMs));
                delayMs *= 2; 
                continue; 
            } else {
                throw new Error(text);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error("Timpul de așteptare a expirat. Procesul a durat prea mult.");
            }
            if (i < maxRetries - 1) {
                console.warn(`[Network] Eroare la conexiune. Reîncerc în ${delayMs}ms...`);
                await new Promise(res => setTimeout(res, delayMs));
                delayMs *= 2;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Sistemul AI este suprasolicitat de prea mulți utilizatori. Te rugăm să încerci din nou în 10 secunde.");
};

const sendSSE = (res, data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

const pipeStream = async (apiRes, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const contentType = apiRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try {
            const json = await apiRes.json();
            const normalized = {};
            let hasNumericKeys = false;
            for (const key of Object.keys(json)) { if (!isNaN(key)) { hasNumericKeys = true; break; } }
            if (hasNumericKeys) {
                const items = Object.values(json);
                Object.assign(normalized, items[0] || {});
                const allUrls = [];
                items.forEach(i => {
                    if (i.file_url) allUrls.push(i.file_url);
                    if (i.video_url) allUrls.push(i.video_url);
                    if (i.url) allUrls.push(i.url);
                });
                if (allUrls.length > 0) normalized.file_urls = allUrls;
            } else {
                Object.assign(normalized, json);
            }
            sendSSE(res, normalized);
            res.write('data: [DONE]\n\n');
        } catch (e) {
            sendSSE(res, { error: 'Eroare parsare JSON Vertex' });
        }
        res.end();
    } else {
        Readable.fromWeb(apiRes.body).pipe(res);
    }
};

const VERTEX_ENDPOINT = "https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1/publishers/google/models/"; 

// --- RUTA PENTRU IMAGINI VERTEX AI ---
app.post('/api/media/image', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        const count = parseInt(number_of_images) || 1;
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

// Exact numele care îți merg în Python
const MODEL_ID = model_id === 'gemini-flash' ? 'gemini-3.1-flash-image-preview' : 'gemini-3-pro-image-preview';
        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${process.env.VERTEX_API_KEY}`;
        
        let allUrls = [];

        // 1. Pregătim pozele de referință O SINGURĂ DATĂ ca să nu consumăm RAM aiurea
        let baseParts = [];
        let cleanPrompt = prompt;

        if (req.files && req.files.length > 0) {
            for (let i = 0; i < req.files.length; i++) {
                baseParts.push({
                    inlineData: {
                        mimeType: req.files[i].mimetype,
                        data: req.files[i].buffer.toString('base64')
                    }
                });
                cleanPrompt = cleanPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
        }

        // 2. Lansăm toate cererile în PARALEL (se fac simultan, deci scapi de eroarea 500 / Timeout)
        const fetchPromises = [];

// 2. Executăm cererile SECVENȚIAL (una câte una) pentru a evita Eroarea 429 la Flash
        for (let j = 0; j < count; j++) {
            let finalPrompt = cleanPrompt + `\n\n[Instruction: Variant ${j+1}. Apply unique artistic differences. Random Seed: ${Math.floor(Math.random() * 999999)}. Aspect Ratio: ${aspect_ratio}]`;
            
            let parts = [...baseParts, { text: finalPrompt }];

            let genConfig = { candidateCount: 1 };
            // Adăugăm configurările doar dacă e Flash
            if (model_id === 'gemini-flash') {
                genConfig.responseModalities = ["IMAGE"];
            }

            const fetchOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: parts }],
                    generationConfig: genConfig
                })
            };

            try {
                // Așteptăm ca cererea curentă să se termine înainte de a trece la următoarea
                const apiRes = await fetchWithRetry(endpoint, fetchOptions);
                const rawText = await apiRes.text();
                const data = JSON.parse(rawText);
                
                if (data.candidates && data.candidates[0]?.content?.parts) {
                    for (const part of data.candidates[0].content.parts) {
                        if (part.inlineData && part.inlineData.data) {
                            const b64 = part.inlineData.data;
                            const mime = part.inlineData.mimeType || 'image/png';
                            const ext = mime.split('/')[1] || 'png';
                            
                            const buffer = Buffer.from(b64, 'base64');
                            const fileName = `generated/${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                            
                            const { error: supaErr } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: mime });
                            if (!supaErr) {
                                const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                                allUrls.push(publicData.publicUrl); // Succes!
                            }
                        }
                    }
                }
                
                // Pauză de protecție de 3 SECUNDE între poze, ca să nu ne blocheze Google
                if (j < count - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                
            } catch (err) {
                console.error(`[Eroare Variația ${j+1}]:`, err.message);
            }
        }

        if (allUrls.length === 0) throw new Error("Generarea a eșuat. Probabil imaginile sunt prea complexe sau serverul Google este ocupat. Mai încearcă o dată.");

        // Taxăm userul corect doar pe câte poze au ieșit cu succes
        const finalCost = allUrls.length * costPerImg;
        await Log.create({ userEmail: user.email, type: 'image', count: allUrls.length, cost: finalCost });
        user.credits -= finalCost;
        await user.save();

        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ file_urls: allUrls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        console.error("Eroare Rută Imagini:", e);
        res.status(500).json({ error: e.message });
    }
});


// --- RUTA PENTRU VIDEO VERTEX AI ---
app.post('/api/media/video', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_videos) || 1;
        const costPerVid = MODEL_PRICES[model_id] || 3;
        const totalCost = count * costPerVid;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        let parts = [];

        if (req.files && req.files.length > 0) {
            parts.push({
                inlineData: {
                    mimeType: req.files[0].mimetype,
                    data: req.files[0].buffer.toString('base64')
                }
            });
            for (let i = 0; i < req.files.length; i++) {
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt = finalPrompt + `\n\n[Instruction: Use the provided image as the starting frame. Resolution: 720p, Duration: 8s, Audio: true, Aspect Ratio: ${aspect_ratio}]`;
        } else {
            finalPrompt = finalPrompt + `\n\n[Instruction: Resolution: 720p, Duration: 8s, Audio: true, Aspect Ratio: ${aspect_ratio}]`;
        }

        parts.push({ text: finalPrompt });

        const googleModelId = model_id === 'veo3.1fast' ? 'veo-3.1-fast' : 'veo-3.1';
        
        const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${googleModelId}:generateContent?key=${process.env.VERTEX_API_KEY}`;
        
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: "user", parts: parts }],
                generationConfig: { candidateCount: count }
            })
        };

        const apiRes = await fetchWithRetry(endpoint, fetchOptions);
        const rawText = await apiRes.text();
        
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (err) {
            throw new Error(`Răspuns invalid server Veo. Răspuns: ${rawText.substring(0, 150)}`);
        }

        let urls = [];
        if (data.candidates) {
            for (const candidate of data.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData && part.inlineData.data) {
                            const b64 = part.inlineData.data;
                            const mime = part.inlineData.mimeType || 'video/mp4';
                            const ext = mime.split('/')[1] || 'mp4';
                            
                            const buffer = Buffer.from(b64, 'base64');
                            const fileName = `generated/vid_${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                            
                            const { error: supaErr } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: mime });
                            if (!supaErr) {
                                const { data: pData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                                urls.push(pData.publicUrl);
                            }
                        }
                    }
                }
            }
        }

        if (urls.length === 0) throw new Error("Modelul Veo nu a returnat niciun video valid.");

        await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });
        user.credits -= totalCost;
        await user.save();

        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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