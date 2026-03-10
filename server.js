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

// Configurare Supabase (Asigură-te că ai adăugat aceste variabile în .env)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Model MongoDB pentru Istoric
const HistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    originalUrl: String,
    supabaseUrl: String,
    prompt: String,
    createdAt: { type: Date, default: Date.now }
});
const History = mongoose.models.History || mongoose.model('History', HistorySchema);

// Model MongoDB pentru Log-uri (adăugat pentru a repara eroarea 500)
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

// ADMIN MIDDLEWARE
const ADMIN_EMAILS = ['banicualex3@gmail.com']; 

const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Acces interzis!" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        
        if (!user) return res.status(403).json({ error: "Cont inexistent." });

        const isAdmin = ADMIN_EMAILS.some(e => e.toLowerCase() === user.email.toLowerCase());
        
        if (isAdmin) {
            req.userId = decoded.userId;
            next();
        } else {
            res.status(403).json({ error: `Ești logat cu [${user.email}], dar e nevoie de [${ADMIN_EMAILS[0]}]. Ai greșit contul?` });
        }
    } catch (e) { 
        return res.status(401).json({ error: "Sesiune invalidă." }); 
    }
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

const GENAIPRO_URL = 'https://genaipro.vn/api/v1';

const MODEL_PRICES = {
    'nano-banana-pro': 1,
    'veo-3-quality': 5,
    'veo-3-fast': 3,
    'veo-2': 3,
};

const sendSSE = (res, data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const pipeStream = async (apiRes, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const contentType = apiRes.headers.get('content-type') || '';

    // Dacă API-ul returnează JSON direct (nu SSE), normalizăm la format SSE
    if (contentType.includes('application/json')) {
        try {
            const json = await apiRes.json();
            // Normalizăm obiectele cu chei "0","1",... (array-like objects)
            const normalized = {};
            let hasNumericKeys = false;
            for (const key of Object.keys(json)) {
                if (!isNaN(key)) { hasNumericKeys = true; break; }
            }
if (hasNumericKeys) {
                const items = Object.values(json);
                const first = items[0] || {};
                Object.assign(normalized, first);
                
                // Căutăm orice fel de URL (video sau imagine)
                const allUrls = [];
                items.forEach(i => {
                    if (i.file_url) allUrls.push(i.file_url);
                    if (i.video_url) allUrls.push(i.video_url);
                    if (i.url) allUrls.push(i.url);
                });
                
                if (allUrls.length > 0) {
                    normalized.file_urls = allUrls;
                }
            } else {
                Object.assign(normalized, json);
            }
            sendSSE(res, normalized);
            res.write('data: [DONE]\n\n');
        } catch (e) {
            sendSSE(res, { error: 'Eroare la parsarea răspunsului API' });
        }
        res.end();
    } else {
        // SSE real — pipe direct
        Readable.fromWeb(apiRes.body).pipe(res);
    }
};

app.post('/api/media/image', authenticate, upload.none(), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_images, model_id } = req.body;
        const count = parseInt(number_of_images) || 1;
        const costPerImg = MODEL_PRICES[model_id] || 1;
        const totalCost = count * costPerImg;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        const formData = new FormData();
        formData.append('prompt', prompt);
        formData.append('aspect_ratio', aspect_ratio);
        formData.append('number_of_images', count);

        const apiRes = await fetch(`${GENAIPRO_URL}/veo/create-image`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` },
            body: formData
        });

        if (!apiRes.ok) {
            const errorDetails = await apiRes.text();
            throw new Error(`Eroare GenAIPro: ${errorDetails}`);
        }

        await Log.create({ userEmail: user.email, type: 'image', count, cost: totalCost });

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/media/video', authenticate, upload.single('start_image'), async (req, res) => {
    try {
        const { prompt, aspect_ratio, number_of_videos, model_id } = req.body;
        const count = parseInt(number_of_videos) || 1;
        const costPerVid = MODEL_PRICES[model_id] || 3;
        const totalCost = count * costPerVid;

        const user = await User.findById(req.userId);
        if (user.credits < totalCost) return res.status(403).json({ error: `Fonduri insuficiente! Ai nevoie de ${totalCost} credite.` });

        let endpoint, fetchOptions;

        if (req.file) {
            endpoint = `${GENAIPRO_URL}/veo/frames-to-video`;
            const formData = new FormData();
            formData.append('prompt', prompt);
            formData.append('aspect_ratio', aspect_ratio);
            formData.append('number_of_videos', count);
            
            const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
            formData.append('start_image', blob, req.file.originalname);

            fetchOptions = {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` },
                body: formData
            };
        } else {
            endpoint = `${GENAIPRO_URL}/veo/text-to-video`;
            fetchOptions = {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}`,
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ prompt, aspect_ratio, number_of_videos: count })
            };
        }

        const apiRes = await fetch(endpoint, fetchOptions);
        
        if (!apiRes.ok) {
            const errorDetails = await apiRes.text();
            throw new Error(`Eroare GenAIPro: ${errorDetails}`);
        }
        
        await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
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

        res.json({
            totalUsers,
            totalImages: totalImages[0]?.total || 0,
            totalVideos: totalVideos[0]?.total || 0,
            recentLogs: logs
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/api-quota', authenticateAdmin, async (req, res) => {
    try {
        const [meRes, veoRes] = await Promise.all([
            fetch(`${GENAIPRO_URL}/me`, { headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` } }),
            fetch(`${GENAIPRO_URL}/veo/me`, { headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` } })
        ]);

        const meData = meRes.ok ? await meRes.json() : { balance: 0 };
        const veoData = veoRes.ok ? await veoRes.json() : { total_quota: 0, used_quota: 0, available_quota: 0 };

        res.json({
            balance: meData.balance,
            veoTotal: veoData.total_quota,
            veoUsed: veoData.used_quota,
            veoAvail: veoData.available_quota
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

if (!process.env.GENAIPRO_API_KEY) console.error("Lipsește cheia API GenAIPro!");

// RUTELE DE API PENTRU ISTORIC (Mutate mai sus pentru a nu fi blocate de catch-all)

// Preia istoricul în funcție de tip (image sau video)
app.get('/api/media/history', authenticate, async (req, res) => {
    try {
        const type = req.query.type || 'image';
        const history = await History.find({ userId: req.userId, type: type })
                                     .sort({ createdAt: -1 })
                                     .limit(50); // Limităm la ultimele 50 pentru performanță
        res.json({ history });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Salvează rezultatele generate în Supabase și în MongoDB
app.post('/api/media/save-history', authenticate, async (req, res) => {
    const { urls, type, prompt } = req.body;
    if (!urls || !urls.length) return res.status(400).json({ error: 'Fără URL-uri.' });

    // Răspundem imediat clientului pentru a nu bloca interfața
    res.status(202).json({ message: 'Salvare pornită în fundal' });

    try {
        for (const url of urls) {
            // 1. Descărcăm fișierul generat temporar
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            const extension = type === 'video' ? 'mp4' : 'png';
            const fileName = `${req.userId}_${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`;

            // 2. Upload în Supabase (bucket-ul trebuie să se numească 'media-history')
            const { data, error } = await supabase.storage
                .from('media-history')
                .upload(fileName, buffer, { 
                    contentType: type === 'video' ? 'video/mp4' : 'image/png' 
                });

            if (error) throw error;

            // 3. Obținem URL-ul public
            const { data: publicData } = supabase.storage.from('media-history').getPublicUrl(fileName);

            // 4. Salvăm în MongoDB
            await History.create({
                userId: req.userId,
                type: type,
                originalUrl: url,
                supabaseUrl: publicData.publicUrl,
                prompt: prompt
            });
        }
    } catch (err) {
        console.error('Eroare la salvarea în Supabase:', err.message);
    }
});

// CATCH-ALL PENTRU FRONTEND (Mutate la final)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));