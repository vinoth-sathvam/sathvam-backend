/**
 * Agent API Route (CJS wrapper for ESM agent)
 *
 * POST /api/agent/run    — Run agent with a prompt (SSE streaming)
 * GET  /api/agent/status — Check if agent is running
 */

const { Router } = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { auth } = require('../middleware/auth');

const router = Router();
let activeAgent = null;

// POST /run — Run agent (SSE streaming)
router.post('/run', auth, async (req, res) => {
  const { prompt, maxTurns, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (!req.user || !['admin', 'ceo'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin or CEO access required' });
  }

  if (activeAgent) {
    return res.status(409).json({ error: 'Agent is already running. Wait for it to finish.' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  activeAgent = { prompt, startedAt: new Date(), user: req.user.name };

  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  sendEvent({ type: 'started', prompt, user: req.user.name });

  // Spawn the agent as a child process (ESM)
  const agentScript = path.resolve(__dirname, '../agent/sathvam-agent.mjs');
  const child = spawn('node', [agentScript, prompt], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000, // 5 min max
  });

  let output = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    // Filter out noise
    if (!text.includes('ExperimentalWarning') && !text.includes('NodeVersionSupport')) {
      output += text;
    }
  });

  child.on('close', (code) => {
    if (output.trim()) {
      // Remove the [Agent session: ...] line
      const clean = output.replace(/\[Agent session: [^\]]+\]\n?/g, '').trim();
      sendEvent({ type: 'result', text: clean });
    } else {
      sendEvent({ type: 'error', message: `Agent exited with code ${code}` });
    }
    sendEvent({ type: 'done' });
    activeAgent = null;
    res.end();
  });

  child.on('error', (err) => {
    sendEvent({ type: 'error', message: err.message });
    sendEvent({ type: 'done' });
    activeAgent = null;
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    activeAgent = null;
  });
});

// GET /status
router.get('/status', auth, (req, res) => {
  if (activeAgent) {
    res.json({
      running: true,
      prompt: activeAgent.prompt,
      startedAt: activeAgent.startedAt,
      user: activeAgent.user,
      elapsed: Math.round((Date.now() - activeAgent.startedAt.getTime()) / 1000),
    });
  } else {
    res.json({ running: false });
  }
});

module.exports = router;
