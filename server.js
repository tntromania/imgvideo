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
    'nano-banana-pro-1k': 1, // În caz că folosești id-ul ăsta în frontend
    'gemini-pro': 2,
    'nano-banana-pro-2k': 2, // ID-uri de siguranță
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

// --- RUTA PENTRU IMAGINI VERTEX AI (Integrare 2.5 Flash Python + 3 Pro) ---
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

        // Verificăm dacă user-ul cere modelul Flash sau Pro
        const isFlash = (model_id === 'gemini-flash' || model_id === 'nano-banana-pro-1k');
        
        // Alegem exact modelele confirmate de tine
        const MODEL_ID = isFlash ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview'; 
        
// Corpul cererii de bază
let requestBody = {
            contents: [{ role: "user", parts: parts }],
            generationConfig: { 
                candidateCount: count
            },
            // MUTĂ ASTA AICI (în afara generationConfig)
            aspectRatio: aspect_ratio 
        };

        if (isFlash) {
            requestBody.generationConfig.responseModalities = ["IMAGE"];
            // Pentru Flash, ne asigurăm că setăm și restul parametrilor corect
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
        
        const apiRes = await fetchWithRetry(endpoint, fetchOptions);
        const rawText = await apiRes.text();
        
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (err) {
            throw new Error(`Google a returnat o eroare fără JSON. Răspuns brut: ${rawText.substring(0, 150)}`);
        }

        if (!apiRes.ok) {
            throw new Error(`Eroare Gemini API: ${data.error?.message || JSON.stringify(data)}`);
        }

        let urls = [];
        
        // Extragem imaginile generate de oricare din cele 2 modele
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

        if (urls.length === 0) throw new Error("Google a răspuns cu succes, dar nu ne-a dat nicio imagine (posibil filtru de siguranță sau eroare la prompt).");

        // Taxăm userul doar pentru pozele generate efectiv
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
            throw new Error(`Răspuns invalid server Veo. Răspuns brut: ${rawText.substring(0, 150)}`);
        }

        if (!apiRes.ok) {
            throw new Error(`Eroare Veo API: ${data.error?.message || JSON.stringify(data)}`);
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

        await Log.create({ userEmail: user.email, type: 'video', count: urls.length, cost: urls.length * costPerVid });
        user.credits -= (urls.length * costPerVid);
        await user.save();

        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ file_urls: urls })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        console.error("Eroare Rută Video:", e);
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