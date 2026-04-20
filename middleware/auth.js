const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

const auth = async (req, res, next) => {
  // Prefer httpOnly cookie; fall back to Authorization header (API tools / legacy)
  const token = req.cookies?.sathvam_admin
    || req.cookies?.sathvam_b2b
    || req.headers.authorization?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Single-session enforcement for admin users only (not customer/b2b tokens)
    // session_token in JWT must match the DB value — new login overwrites it
    if (decoded.role && decoded.session_token) {
      const { data: row } = await supabase
        .from('users')
        .select('session_token')
        .eq('id', decoded.id)
        .single();

      if (!row || row.session_token !== decoded.session_token) {
        return res.status(401).json({
          error: 'Session ended — your account was logged in on another device.',
          code: 'SESSION_SUPERSEDED',
        });
      }
    }

    req.user = decoded;
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
