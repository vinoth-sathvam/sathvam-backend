'use strict';
/**
 * Admin API audit log middleware.
 *
 * Logs every mutating admin request (POST/PUT/PATCH/DELETE) to the
 * admin_audit_logs table in Supabase after the response is sent.
 *
 * Mount AFTER auth middleware so req.user is already populated.
 * Safe to use globally — skips requests with no req.user (unauthenticated),
 * and skips read-only GET/HEAD methods.
 */

const supabase = require('../config/supabase');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_PATHS = ['/health', '/api/auth/logout']; // never log these

function auditLog(req, res, next) {
  if (!MUTATION_METHODS.has(req.method)) return next();

  const path = req.path;
  if (SKIP_PATHS.some(p => path.startsWith(p))) return next();

  res.on('finish', () => {
    // Only log authenticated admin requests
    if (!req.user) return;

    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    supabase.from('admin_audit_logs').insert({
      user_id:  String(req.user.id),
      username: req.user.username,
      role:     req.user.role,
      method:   req.method,
      path:     req.originalUrl || req.path,
      status:   res.statusCode,
      ip,
    }).then(({ error }) => {
      if (error) console.error('[audit]', error.message);
    });
  });

  next();
}

module.exports = auditLog;
