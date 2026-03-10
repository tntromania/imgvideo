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

// Middleware pentru procesarea fișierelor (form-data)
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CONECTARE BAZA DE DATE
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

// Schema pentru Loguri (Dashboard)
const LogSchema = new mongoose.Schema({
    userEmail: String,
    type: String, // 'image' sau 'video'
    count: Number,
    cost: Number,
    createdAt: { type: Date, default: Date.now }
});
const Log = mongoose.models.Log || mongoose.model('Log', LogSchema);

// AUTH MIDDLEWARE
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) { return res.status(401).json({ error: "Sesiune expirată." }); }
};

// ADMIN MIDDLEWARE (Pune emailul tău aici!)
const ADMIN_EMAILS = ['banicualex3@gmail.com']; // <-- Ai pus adresa ta aici, da?

const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Acces interzis!" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        
        if (user && ADMIN_EMAILS.includes(user.email)) {
            req.userId = decoded.userId;
            next();
        } else {
            // ACUM ÎȚI VA ZICE EXACT CE EMAIL A GĂSIT!
            res.status(403).json({ error: `Acces respins! Adresa ta (${user?.email}) nu este în lista de admini din server.js.` });
        }
    } catch (e) { 
        return res.status(401).json({ error: "Sesiune invalidă." }); 
    }
};

// RUTE LOGIN (Sincronizate cu HUB)
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

// ========================================================
// RUTE GENERARE (PROXY CĂTRE GENAIPRO)
// ========================================================
const GENAIPRO_URL = 'https://genaipro.vn/api/v1';

// Prețuri (Sincronizate cu frontend-ul)
const MODEL_PRICES = {
    'nano-banana-pro': 1,
    'nano-banana-fast': 1,
    'veo-3-quality': 5,
    'veo-3-fast': 3,
    'veo-2': 3,
};

// Funcție ajutătoare pentru a trimite fluxul SSE (Server-Sent Events) înapoi la client
const pipeStream = (apiRes, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    Readable.fromWeb(apiRes.body).pipe(res);
};

// 1. IMAGINI
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
            console.error(`❌ Eroare GenAIPro (Status ${apiRes.status}):`, errorDetails);
            throw new Error(`Eroare de la furnizorul AI. Verifică terminalul serverului.`);
        }

        // Salvăm log-ul în baza de date
        await Log.create({ userEmail: user.email, type: 'image', count, cost: totalCost });

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
    } catch (e) {
        console.error("🔥 Eroare internă /api/media/image:", e);
        res.status(500).json({ error: e.message });
    }
});

// 2. VIDEO (Text to Video SAU Image to Video)
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
                body: JSON.stringify({
                    prompt: prompt,
                    aspect_ratio: aspect_ratio,
                    number_of_videos: count
                })
            };
        }

        const apiRes = await fetch(endpoint, fetchOptions);
        
        if (!apiRes.ok) {
            const errorDetails = await apiRes.text();
            console.error(`❌ Eroare GenAIPro (Status ${apiRes.status}):`, errorDetails);
            throw new Error(`Eroare de la furnizorul AI. Verifică terminalul serverului.`);
        }
        
        // Salvăm log-ul în baza de date
        await Log.create({ userEmail: user.email, type: 'video', count, cost: totalCost });

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
    } catch (e) {
        console.error("🔥 Eroare internă /api/media/video:", e);
        res.status(500).json({ error: e.message });
    }
});

// 3. STATISTICI DASHBOARD ADMIN
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. PRELUARE COTĂ DIRECT DE LA GENAIPRO
app.get('/api/admin/api-quota', authenticateAdmin, async (req, res) => {
    try {
        const [meRes, veoRes] = await Promise.all([
            fetch(`${GENAIPRO_URL}/me`, { headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` } }),
            fetch(`${GENAIPRO_URL}/veo/me`, { headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` } })
        ]);

        const meData = meRes.ok ? await meRes.json() : { balance: 'Eroare' };
        const veoData = veoRes.ok ? await veoRes.json() : { total_quota: 0, used_quota: 0, available_quota: 0 };

        res.json({
            balance: meData.balance,
            veoTotal: veoData.total_quota,
            veoUsed: veoData.used_quota,
            veoAvail: veoData.available_quota
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Verifică dacă cheia există
if (!process.env.GENAIPRO_API_KEY) {
    console.error("Lipsește cheia API GenAIPro!");
}

// FORȚĂM RUTA DE ADMIN SĂ DESCHIDĂ ADMIN.HTML
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Asta trebuie să rămână mereu ULTIMA rută din fișier:
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));