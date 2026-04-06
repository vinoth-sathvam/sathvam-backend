const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  // Prefer httpOnly cookie; fall back to Authorization header (API tools / legacy)
  const token = req.cookies?.sathvam_admin
    || req.cookies?.sathvam_b2b
    || req.headers.authorization?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role))
    return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

module.exports = { auth, requireRole };
