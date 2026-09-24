'use strict';

const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { httpError } = require('./http');

/**
 * Google sign-in is verified here, on the server. A successful sign-in for the
 * one allowed account is exchanged for the app's own session token, which every
 * /api request must carry.
 */
function createAuth({ config, googleClient = new OAuth2Client(config.googleClientId) }) {
  async function loginWithGoogle(credential) {
    if (typeof credential !== 'string' || !credential || credential.length > 4096) {
      throw httpError(400, 'חסר אישור התחברות מ-Google');
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch (_) {
      throw httpError(401, 'אימות החשבון מול Google נכשל');
    }

    const email = String(payload.email || '').toLowerCase();
    if (!payload.email_verified || email !== config.allowedEmail) {
      throw httpError(403, 'החשבון הזה אינו מורשה להשתמש באפליקציה');
    }

    const user = { email, name: payload.name || email, picture: payload.picture || null };
    const token = jwt.sign({ email, name: user.name }, config.sessionSecret, {
      algorithm: 'HS256',
      expiresIn: `${config.sessionDays}d`,
    });
    return { token, user, expiresAt: Date.now() + config.sessionDays * 86_400_000 };
  }

  function requireAuth(req, res, next) {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ success: false, error: 'נדרשת התחברות' });
    try {
      const payload = jwt.verify(match[1], config.sessionSecret, { algorithms: ['HS256'] });
      if (String(payload.email || '').toLowerCase() !== config.allowedEmail) throw new Error('email');
      req.user = payload;
      return next();
    } catch (_) {
      return res.status(401).json({ success: false, error: 'ההתחברות פגה, יש להתחבר מחדש' });
    }
  }

  return { loginWithGoogle, requireAuth };
}

module.exports = { createAuth };
