const jwt = require('jsonwebtoken');

const authenticateJWT = (req, res, next) => {

    // ✅ CRITICAL: allow preflight to pass
    if (req.method === 'OPTIONS') {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];

    if (!token) {
        console.warn('[AUTH] Missing bearer token', {
            method: req.method,
            path: req.originalUrl,
            timestamp: new Date().toISOString(),
        });
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.warn('[AUTH] Invalid bearer token', {
                method: req.method,
                path: req.originalUrl,
                timestamp: new Date().toISOString(),
                error: err?.message,
            });
            return res.status(401).json({ error: 'Invalid token.' });
        }

        // 🔥 IMPORTANT: attach user
        if (decoded && decoded.userId && !decoded.id) {
            decoded.id = decoded.userId;
        }
        if (decoded && decoded.user_id && !decoded.id) {
            decoded.id = decoded.user_id;
        }
        if (decoded && decoded.roleName && !decoded.role) {
            decoded.role = decoded.roleName;
        }

        req.user = decoded;

        next();
    });
};

module.exports = authenticateJWT;
