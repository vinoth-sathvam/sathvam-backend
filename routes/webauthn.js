const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const router = express.Router();

const RP_NAME = 'Sathvam Admin';
const RP_ID   = process.env.WEBAUTHN_RP_ID || 'admin.sathvam.in';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN || 'https://admin.sathvam.in';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

async function issueSessionToken(userId) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await supabase.from('users').update({ session_token: sessionToken }).eq('id', userId);
  return sessionToken;
}

// Helper: store challenge in DB
async function storeChallenge(userId, challenge, type) {
  // Clean up expired challenges first
  await supabase.from('webauthn_challenges').delete().lt('expires_at', new Date().toISOString());
  const { data, error } = await supabase.from('webauthn_challenges').insert({
    user_id: userId || null,
    challenge,
    type,
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

// Helper: retrieve and consume challenge
async function consumeChallenge(challengeId, type) {
  const { data, error } = await supabase.from('webauthn_challenges')
    .select('*').eq('id', challengeId).eq('type', type).single();
  if (error || !data) return null;
  // Delete after reading (one-time use)
  await supabase.from('webauthn_challenges').delete().eq('id', challengeId);
  if (new Date(data.expires_at) < new Date()) return null;
  return data;
}

// Helper: get user's existing credentials
async function getUserCredentials(userId) {
  const { data } = await supabase.from('webauthn_credentials')
    .select('*').eq('user_id', userId);
  return data || [];
}

// ─── REGISTRATION (requires admin login) ──────────────────────────────────

// Step 1: Generate registration options
router.post('/register-options', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: user } = await supabase.from('users')
      .select('id,username,name').eq('id', userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existingCreds = await getUserCredentials(userId);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.username,
      userDisplayName: user.name || user.username,
      userID: Buffer.from(userId),
      attestationType: 'none',
      excludeCredentials: existingCreds.map(c => ({
        id: c.credential_id,
        transports: c.transports || [],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform', // fingerprint / face on device
      },
    });

    const challengeId = await storeChallenge(userId, options.challenge, 'registration');

    res.json({ options, challengeId });
  } catch (e) {
    console.error('WebAuthn register-options error:', e);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// Step 2: Verify registration response
router.post('/register-verify', auth, async (req, res) => {
  try {
    const { challengeId, credential, deviceName } = req.body;
    if (!challengeId || !credential) return res.status(400).json({ error: 'Missing data' });

    const challengeData = await consumeChallenge(challengeId, 'registration');
    if (!challengeData) return res.status(400).json({ error: 'Challenge expired or invalid' });

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    const { credential: regCred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    // Store credential
    const { error } = await supabase.from('webauthn_credentials').insert({
      credential_id: regCred.id,
      user_id: req.user.id,
      public_key: Buffer.from(regCred.publicKey).toString('base64url'),
      counter: regCred.counter,
      transports: credential.response?.transports || [],
      device_name: deviceName || 'Fingerprint',
    });

    if (error) {
      console.error('WebAuthn credential save error:', error);
      return res.status(500).json({ error: 'Failed to save credential' });
    }

    res.json({ success: true, message: 'Fingerprint registered successfully' });
  } catch (e) {
    console.error('WebAuthn register-verify error:', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── AUTHENTICATION (no login required) ────────────────────────────────────

// Step 1: Generate authentication options
router.post('/login-options', async (req, res) => {
  try {
    const { username } = req.body;

    let allowCredentials = [];
    let challengeUserId = null;

    if (username) {
      // If username provided, only allow that user's credentials
      const { data: user } = await supabase.from('users')
        .select('id').eq('username', username).eq('active', true).single();
      if (!user) return res.status(404).json({ error: 'No fingerprint registered for this user' });

      const creds = await getUserCredentials(user.id);
      if (creds.length === 0) return res.status(404).json({ error: 'No fingerprint registered for this user' });

      challengeUserId = user.id;
      allowCredentials = creds.map(c => ({
        id: c.credential_id,
        transports: c.transports || [],
      }));
    }
    // If no username: discoverable credential (passkey) flow — allowCredentials stays empty

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'required',
    });

    const challengeId = await storeChallenge(challengeUserId, options.challenge, 'authentication');

    res.json({ options, challengeId });
  } catch (e) {
    console.error('WebAuthn login-options error:', e);
    res.status(500).json({ error: 'Failed to generate login options' });
  }
});

// Step 2: Verify authentication response → issue JWT
router.post('/login-verify', async (req, res) => {
  try {
    const { challengeId, credential } = req.body;
    if (!challengeId || !credential) return res.status(400).json({ error: 'Missing data' });

    const challengeData = await consumeChallenge(challengeId, 'authentication');
    if (!challengeData) return res.status(400).json({ error: 'Challenge expired or invalid' });

    // Find the credential in DB
    const credentialId = credential.id;
    const { data: storedCred, error: credErr } = await supabase.from('webauthn_credentials')
      .select('*').eq('credential_id', credentialId).single();
    if (credErr || !storedCred) return res.status(401).json({ error: 'Unknown credential' });

    // Get the user
    const { data: user } = await supabase.from('users')
      .select('id,username,name,role,active').eq('id', storedCred.user_id).single();
    if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: storedCred.credential_id,
        publicKey: Buffer.from(storedCred.public_key, 'base64url'),
        counter: storedCred.counter,
        transports: storedCred.transports || [],
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Fingerprint verification failed' });
    }

    // Update counter (replay protection)
    await supabase.from('webauthn_credentials')
      .update({ counter: verification.authenticationInfo.newCounter })
      .eq('credential_id', credentialId);

    // Issue session token + JWT cookie (same as password login)
    const sessionToken = await issueSessionToken(user.id);
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, session_token: sessionToken },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('sathvam_admin', token, COOKIE_OPTS);
    res.json({ user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  } catch (e) {
    console.error('WebAuthn login-verify error:', e);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ─── MANAGEMENT (requires admin login) ─────────────────────────────────────

// List registered credentials for current user
router.get('/credentials', auth, async (req, res) => {
  try {
    const creds = await getUserCredentials(req.user.id);
    res.json(creds.map(c => ({
      credential_id: c.credential_id,
      device_name: c.device_name,
      created_at: c.created_at,
    })));
  } catch { res.status(500).json({ error: 'Failed to fetch credentials' }); }
});

// Delete a credential
router.delete('/credentials/:credentialId', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('webauthn_credentials')
      .delete().eq('credential_id', req.params.credentialId).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Failed to delete' });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete credential' }); }
});

module.exports = router;
