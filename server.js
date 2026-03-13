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

// PREȚURILE NOI SETATE DE TINE PENTRU VERTEX
const MODEL_PRICES = {
    'nano-banana-pro-1k': 1,
    'nano-banana-pro-2k': 2,
    'nano-banana-pro-4k': 4,
    'veo3.1': 5,
    'veo3.1fast': 3,
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

// --- FUNCTIE AJUTATOARE PENTRU APELUL VERTEX REST ---
// Folosește direct adresa ta de API
const VERTEX_ENDPOINT = "https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1/publishers/google/models/"; 

// --- RUTA PENTRU IMAGINI VERTEX AI (NANO BANANA PRO) ---
app.post('/api/media/image', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_images) || 1;
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        let crefUrls = [];
        if (req.files && req.files.length > 0) {
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                const fileName = `refs/${req.userId}_${Date.now()}_${i}.png`;
                const { error } = await supabase.storage.from('media-history').upload(fileName, file.buffer, { contentType: file.mimetype });
                
                if (!error) {
                    const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                    const tag = `@img${i+1}`;
                    
                    // Ștergem @img1 din text și îl păstrăm ca referință oficială
                    if (finalPrompt.includes(tag)) {
                        finalPrompt = finalPrompt.replace(new RegExp(tag, 'g'), '').trim();
                    }
                    crefUrls.push(publicData.publicUrl);
                }
            }
        }

        // Adăugăm referința de personaj în prompt la final
        if (crefUrls.length > 0) {
            finalPrompt = `${finalPrompt} --cref ${crefUrls.join(' ')} --cw 100`;
            finalPrompt = finalPrompt.replace(/\s+/g, ' ').trim();
        }

        // Extragem rezoluția din model_id (ex: nano-banana-pro-4k devine 4k)
        let resolutionParam = "1k";
        if (model_id.includes('2k')) resolutionParam = "2k";
        if (model_id.includes('4k')) resolutionParam = "4k";

        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instances: [ { prompt: finalPrompt } ],
                parameters: {
                    sampleCount: count,
                    aspectRatio: aspect_ratio,
                    outputOptions: { resolution: resolutionParam }
                }
            })
        };

        // Folosim domeniul corect pentru API Keys și numele oficial din panoul tău
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro:predict?key=${process.env.VERTEX_API_KEY}`;
        
        const apiRes = await fetch(endpoint, fetchOptions);
        const data = await apiRes.json();
        
        if (!apiRes.ok) {
            throw new Error(`Eroare Nano Banana API: ${data.error?.message || 'Nu uita să activezi API-ul din consolă!'}`);
        }

        let urls = [];
        
        // Google returnează imaginile în Base64. Le urcăm pe Supabase-ul tău.
        if (data.predictions) {
            for (let i = 0; i < data.predictions.length; i++) {
                const b64 = data.predictions[i].bytesBase64Encoded;
                if (!b64) continue;
                
                const buffer = Buffer.from(b64, 'base64');
                const fileName = `generated/${req.userId}_${Date.now()}_${i}.png`;
                const { error: supaErr } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: 'image/png' });
                
                if (!supaErr) {
                    const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                    urls.push(publicData.publicUrl);
                }
            }
        }

        if (urls.length === 0) throw new Error("Modelul nu a putut genera imaginile. Verifică promptul.");

        await Log.create({ userEmail: user.email, type: 'image', count, cost: totalCost });
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

// --- RUTA PENTRU VIDEO VERTEX AI (VEO 3.1) ---
app.post('/api/media/video', authenticate, upload.array('ref_images', 5), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
        let finalPrompt = prompt;
        const count = parseInt(number_of_videos) || 1;
        const costPerVid = MODEL_PRICES[model_id] || 3;
        const totalCost = count * costPerVid;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        let startImageBase64 = null;

        if (req.files && req.files.length > 0) {
            // Veo citește poza de start în Base64
            startImageBase64 = req.files[0].buffer.toString('base64');
            for (let i = 0; i < req.files.length; i++) {
                finalPrompt = finalPrompt.replace(new RegExp(`@img${i+1}`, 'g'), '').trim();
            }
            finalPrompt = finalPrompt.replace(/\s+/g, ' ').trim();
        }

        const payload = {
            instances: [ { prompt: finalPrompt } ],
            parameters: {
                aspectRatio: aspect_ratio,
                resolution: "720p",
                duration: "8s",
                includeAudio: true,
                sampleCount: count
            }
        };

        if (startImageBase64) {
            payload.instances[0].image = { bytesBase64Encoded: startImageBase64 };
        }

        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };

        const googleModelId = model_id === 'veo3.1fast' ? 'veo-3.1-fast' : 'veo-3.1';
        
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelId}:predict?key=${process.env.VERTEX_API_KEY}`;
        const apiRes = await fetch(endpoint, fetchOptions);
        const data = await apiRes.json();
        
        if (!apiRes.ok) {
            throw new Error(`Eroare Veo 3.1 API: ${data.error?.message || 'Eroare necunoscută.'}`);
        }

        let urls = [];
        
        if (data.predictions) {
            for (let i = 0; i < data.predictions.length; i++) {
                const b64 = data.predictions[i].bytesBase64Encoded || data.predictions[i].video;
                if (!b64) continue;
                
                const buffer = Buffer.from(b64, 'base64');
                const fileName = `generated/vid_${req.userId}_${Date.now()}_${i}.mp4`;
                const { error: supaErr } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: 'video/mp4' });
                
                if (!supaErr) {
                    const { data: pData } = supabase.storage.from('media-history').getPublicUrl(fileName);
                    urls.push(pData.publicUrl);
                }
            }
        }

        if (urls.length === 0) throw new Error("Modelul nu a putut genera video-ul.");

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
    res.status(202).json({ message: 'Salvare pornită în fundal' });

    try {
        for (const url of urls) {
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            const extension = type === 'video' ? 'mp4' : 'png';
            const fileName = `${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`;
            const { data, error } = await supabase.storage.from('media-history').upload(fileName, buffer, { contentType: type === 'video' ? 'video/mp4' : 'image/png' });
            if (error) throw error;
            const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);
            await History.create({ userId: req.userId, type: type, originalUrl: url, supabaseUrl: publicData.publicUrl, prompt: prompt });
        }
    } catch (err) { console.error('Eroare la salvarea în Supabase:', err.message); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));