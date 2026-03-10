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
const PORT = process.env.PORT || 3000;
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

        // MODIFICAREA ESTE AICI: Preluăm și printăm eroarea exactă trimisă de ei
        if (!apiRes.ok) {
            const errorDetails = await apiRes.text();
            console.error(`❌ Eroare GenAIPro (Status ${apiRes.status}):`, errorDetails);
            throw new Error(`Eroare de la furnizorul AI. Verifică terminalul serverului.`);
        }

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
    } catch (e) {
        // MODIFICAREA ESTE AICI: Printăm eroarea și în consola Node.js
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

        const formData = new FormData();
        formData.append('prompt', prompt);
        formData.append('aspect_ratio', aspect_ratio);
        formData.append('number_of_videos', count);

        let endpoint = `${GENAIPRO_URL}/veo/text-to-video`;

        // Dacă a încărcat o poză, atașăm fișierul
        if (req.file) {
            endpoint = `${GENAIPRO_URL}/veo/frames-to-video`;
            const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
            formData.append('start_image', blob, req.file.originalname);
        }

        const apiRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.GENAIPRO_API_KEY}` },
            body: formData
        });

        if (!apiRes.ok) throw new Error("Eroare la generare din serverul AI.");

        user.credits -= totalCost;
        await user.save();

        pipeStream(apiRes, res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Verifică dacă cheia există înainte de fetch
if (!process.env.GENAIPRO_API_KEY) {
    console.error("Lipsește cheia API GenAIPro!");
}
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Media Studio rulează pe portul ${PORT}`));