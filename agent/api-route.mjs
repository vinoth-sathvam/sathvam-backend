/**
 * Agent API Route — Express middleware for the Sathvam AI Agent
 *
 * Mount in server.js:
 *   import { agentRouter } from './agent/api-route.mjs';
 *   app.use('/api/agent', agentRouter);
 *
 * Endpoints:
 *   POST /api/agent/run    — Run agent with a prompt (streaming SSE)
 *   GET  /api/agent/status — Check if agent is running
 */

import { Router } from 'express';
import { runAgent } from './sathvam-agent.mjs';

const router = Router();
let activeAgent = null;

// POST /run — Run agent (SSE streaming)
router.post('/run', async (req, res) => {
  const { prompt, maxTurns, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  // Check auth (admin/ceo only)
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
  });

  activeAgent = { prompt, startedAt: new Date(), user: req.user.name };

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'started', prompt, user: req.user.name });

  try {
    const result = await runAgent(prompt, {
      maxTurns: maxTurns || 30,
      model: model || 'claude-sonnet-4-6',
      silent: true,
    });

    sendEvent({ type: 'result', text: result });
    sendEvent({ type: 'done' });
  } catch (e) {
    sendEvent({ type: 'error', message: e.message });
  } finally {
    activeAgent = null;
    res.end();
  }
});

// GET /status
router.get('/status', (req, res) => {
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

export { router as agentRouter };
