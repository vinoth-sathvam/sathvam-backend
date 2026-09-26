#!/usr/bin/env node
/**
 * Sathvam AI Agent — Claude Agent SDK
 *
 * Autonomous agent with full access to:
 *   - PostgreSQL database (via PostgREST)
 *   - systemd services (start/stop/status)
 *   - Docker deployment (backend/frontend)
 *   - WhatsApp messaging (Green API)
 *   - Automation scripts
 *   - Git operations
 *   - File system (built-in Read/Write/Edit/Bash/Glob/Grep)
 *
 * Usage:
 *   CLI:  node agent/sathvam-agent.mjs "Fix all failing services"
 *   API:  POST /api/agent/run { prompt: "Check duplicate bank transactions" }
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execSync, exec } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = '/home/ubuntu/sathvam-frontend/sathvam-vercel';

// ── Load env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envFile = readFileSync(path.join(BACKEND_DIR, '.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
    // Host override
    try {
      const override = readFileSync('/home/ubuntu/.env.host-override', 'utf8');
      for (const line of override.split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
  } catch (e) { console.error('Warning: could not load .env:', e.message); }
}
loadEnv();

const POSTGREST_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:3100';
const POSTGREST_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ── Custom Tools ─────────────────────────────────────────────────────────────

// 1. Database Query Tool
const queryDatabase = tool(
  'query_database',
  'Query PostgreSQL via PostgREST. Supports SELECT with filters, INSERT, UPDATE, DELETE. Use PostgREST query syntax for filters (eq, gt, lt, like, ilike, in, is, etc). Examples: table="products" method="GET" query="select=name,price&active=eq.true&order=name.asc" or table="settings" method="GET" query="key=eq.my_key"',
  {
    table: z.string().describe('Table name (e.g., products, webstore_orders, bank_transactions, settings, b2b_orders, customers)'),
    method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).describe('HTTP method: GET=select, POST=insert, PATCH=update, DELETE=delete'),
    query: z.string().optional().describe('PostgREST query string for GET (e.g., "select=id,name&active=eq.true&limit=10"). For PATCH/DELETE, use filters (e.g., "id=eq.123")'),
    body: z.string().optional().describe('JSON body for POST/PATCH (e.g., \'{"name":"test","active":true}\')'),
  },
  async ({ table, method, query: qs, body }) => {
    try {
      const url = `${POSTGREST_URL}/${table}${qs ? '?' + qs : ''}`;
      const headers = {
        'Authorization': `Bearer ${POSTGREST_KEY}`,
        'apikey': POSTGREST_KEY,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : method === 'PATCH' ? 'return=representation' : '',
      };
      const opts = { method, headers };
      if (body && (method === 'POST' || method === 'PATCH')) opts.body = body;
      const resp = await fetch(url, opts);
      const text = await resp.text();
      if (!resp.ok) return { content: [{ type: 'text', text: `Error ${resp.status}: ${text}` }] };
      // Truncate large results
      const result = text.length > 5000 ? text.slice(0, 5000) + '\n... (truncated)' : text;
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// 2. Service Management Tool
const manageService = tool(
  'manage_service',
  'Manage systemd services on the server. Check status, start, stop, restart, or list all sathvam services and timers.',
  {
    action: z.enum(['status', 'start', 'stop', 'restart', 'list-services', 'list-timers', 'journal']).describe('Action to perform'),
    service: z.string().optional().describe('Service name (e.g., sathvam-auto-po, sathvam-monitor-api). Not needed for list-* actions'),
    lines: z.number().optional().describe('Number of journal lines to show (default 20)'),
  },
  async ({ action, service, lines }) => {
    try {
      let cmd;
      switch (action) {
        case 'status':
          cmd = `sudo systemctl status ${service}.service 2>&1 | head -20`;
          break;
        case 'start':
          cmd = `sudo systemctl start ${service}.service 2>&1 && echo "Started ${service} ✓"`;
          break;
        case 'stop':
          cmd = `sudo systemctl stop ${service}.service 2>&1 && echo "Stopped ${service} ✓"`;
          break;
        case 'restart':
          cmd = `sudo systemctl restart ${service}.service 2>&1 && echo "Restarted ${service} ✓"`;
          break;
        case 'list-services':
          cmd = `systemctl list-units --type=service --all 2>&1 | grep sathvam`;
          break;
        case 'list-timers':
          cmd = `systemctl list-timers --all 2>&1 | grep sathvam`;
          break;
        case 'journal':
          cmd = `sudo journalctl -u ${service}.service --no-pager -n ${lines || 20} 2>&1`;
          break;
      }
      const output = execSync(cmd, { timeout: 15000, encoding: 'utf8' });
      return { content: [{ type: 'text', text: output }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.stderr || e.message}` }] };
    }
  }
);

// 3. Deploy Tool
const deploy = tool(
  'deploy',
  'Deploy backend or frontend. Backend: triggers auto-deploy (git pull + docker rebuild). Frontend: builds and deploys via zero-downtime script.',
  {
    target: z.enum(['backend', 'frontend']).describe('What to deploy'),
    action: z.enum(['deploy', 'status', 'logs']).describe('deploy=trigger deploy, status=check current state, logs=view deploy log'),
  },
  async ({ target, action }) => {
    try {
      let cmd;
      if (action === 'logs') {
        cmd = 'tail -30 /var/log/sathvam-deploy.log 2>&1';
      } else if (action === 'status') {
        cmd = 'sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1';
      } else if (target === 'backend') {
        cmd = 'sudo systemctl start sathvam-auto-deploy.service 2>&1 && echo "Backend deploy triggered ✓"';
      } else {
        cmd = 'cd /home/ubuntu && sudo bash deploy-frontend-admin.sh 2>&1 | tail -20';
      }
      const output = execSync(cmd, { timeout: 120000, encoding: 'utf8' });
      return { content: [{ type: 'text', text: output }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.stderr || e.message}` }] };
    }
  }
);

// 4. WhatsApp Tool
const sendWhatsApp = tool(
  'send_whatsapp',
  'Send WhatsApp message via Green API. Can send to individual phone numbers or groups. Use the backend API endpoint to ensure messages are logged in the admin panel.',
  {
    to: z.string().describe('Phone number (e.g., 919876543210) or group ID (e.g., 918144803555-1613471362@g.us). Known groups: "Sathvam Factory" = 120363403146320645@g.us, "Sathvam Oils and Spices" = 918144803555-1613471362@g.us'),
    message: z.string().describe('Message text. Supports WhatsApp formatting: *bold*, _italic_, ~strikethrough~'),
    via_api: z.boolean().optional().describe('If true, send via backend API (logged in admin panel). If false, send directly via Green API (default: true)'),
  },
  async ({ to, message, via_api }) => {
    try {
      if (via_api !== false) {
        // Send via backend API so it appears in admin WhatsApp panel
        const resp = await fetch('https://api.sathvam.in/api/whatsapp/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `sathvam_admin=${process.env.AGENT_ADMIN_TOKEN || ''}`,
          },
          body: JSON.stringify({ phone: to, message, type: 'text' }),
        });
        const data = await resp.text();
        return { content: [{ type: 'text', text: resp.ok ? `Sent via API ✓: ${data}` : `API Error ${resp.status}: ${data}` }] };
      }
      // Direct Green API
      const instanceId = process.env.GREENAPI_INSTANCE_ID;
      const apiToken = process.env.GREENAPI_API_TOKEN;
      const chatId = to.includes('@') ? to : `${to}@c.us`;
      const resp = await fetch(`https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message }),
      });
      const data = await resp.json();
      return { content: [{ type: 'text', text: `Sent ✓ ID: ${data.idMessage}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// 5. Docker Tool
const dockerOps = tool(
  'docker_ops',
  'Run Docker operations — view containers, logs, exec commands inside containers.',
  {
    action: z.enum(['ps', 'logs', 'exec', 'stats']).describe('ps=list containers, logs=view logs, exec=run command in container, stats=resource usage'),
    container: z.string().optional().describe('Container name (e.g., ubuntu-backend-1, traefik, sathvam-store)'),
    command: z.string().optional().describe('For exec: command to run inside container. For logs: --since flag (e.g., "5m")'),
    lines: z.number().optional().describe('Number of log lines (default 30)'),
  },
  async ({ action, container, command, lines }) => {
    try {
      let cmd;
      switch (action) {
        case 'ps':
          cmd = 'sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>&1';
          break;
        case 'logs':
          cmd = `sudo docker logs ${container} --tail ${lines || 30} ${command ? '--since ' + command : ''} 2>&1`;
          break;
        case 'exec':
          cmd = `sudo docker exec ${container} ${command} 2>&1`;
          break;
        case 'stats':
          cmd = 'sudo docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>&1';
          break;
      }
      const output = execSync(cmd, { timeout: 30000, encoding: 'utf8' });
      return { content: [{ type: 'text', text: output.length > 5000 ? output.slice(-5000) : output }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.stderr || e.message}` }] };
    }
  }
);

// 6. Git Tool
const gitOps = tool(
  'git_ops',
  'Run git operations on backend or frontend repos.',
  {
    repo: z.enum(['backend', 'frontend']).describe('Which repo'),
    command: z.string().describe('Git command to run (e.g., "status", "log --oneline -10", "diff", "add .", "commit -m \\"message\\"", "push origin main")'),
  },
  async ({ repo, command }) => {
    try {
      const cwd = repo === 'backend' ? BACKEND_DIR : FRONTEND_DIR;
      const output = execSync(`git ${command}`, { cwd, timeout: 30000, encoding: 'utf8' });
      return { content: [{ type: 'text', text: output || '(no output)' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.stderr || e.message}` }] };
    }
  }
);

// 7. Server Health Tool
const serverHealth = tool(
  'server_health',
  'Check server health — CPU, memory, disk, SSL certs, API health.',
  {
    check: z.enum(['overview', 'cpu', 'memory', 'disk', 'ssl', 'api-health', 'monitor-metrics']).describe('What to check'),
  },
  async ({ check }) => {
    try {
      let cmd;
      switch (check) {
        case 'overview':
          cmd = `echo "=== CPU ===" && top -bn1 | head -5 && echo "\\n=== Memory ===" && free -h && echo "\\n=== Disk ===" && df -h / && echo "\\n=== Docker ===" && sudo docker ps --format "{{.Names}}: {{.Status}}" 2>&1`;
          break;
        case 'cpu': cmd = 'top -bn1 | head -10'; break;
        case 'memory': cmd = 'free -h'; break;
        case 'disk': cmd = 'df -h'; break;
        case 'ssl': cmd = 'sudo /home/ubuntu/sathvam-frontend/sathvam-vercel/scripts/ssl-cert-monitor.sh --check-only 2>&1'; break;
        case 'api-health': cmd = 'curl -s https://api.sathvam.in/health 2>&1'; break;
        case 'monitor-metrics': cmd = 'curl -s http://127.0.0.1:9191/metrics 2>&1 | head -100'; break;
      }
      const output = execSync(cmd, { timeout: 15000, encoding: 'utf8' });
      return { content: [{ type: 'text', text: output }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.stderr || e.message}` }] };
    }
  }
);

// ── Create MCP Server with all tools ─────────────────────────────────────────
const sathvamServer = createSdkMcpServer({
  name: 'sathvam-tools',
  tools: [queryDatabase, manageService, deploy, sendWhatsApp, dockerOps, gitOps, serverHealth],
});

// ── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the Sathvam AI Agent — an autonomous operations agent for Sathvam Oils & Spices Pvt Ltd's ERP system.

## Your Capabilities
You have full access to:
- **Database**: Query/modify PostgreSQL via PostgREST (products, orders, customers, bank_transactions, settings, etc.)
- **Services**: Manage all sathvam-* systemd services and timers
- **Docker**: View containers, logs, exec commands, deploy backend/frontend
- **WhatsApp**: Send messages to individuals or groups
- **Git**: Commit, push, view diffs across backend/frontend repos
- **File System**: Read, write, edit any file on the server (built-in tools)
- **Server Health**: CPU, memory, disk, SSL, API health monitoring

## Key Paths
- Backend: /home/ubuntu/sathvam-backend/ (Node.js/Express API)
- Frontend: /home/ubuntu/sathvam-frontend/sathvam-vercel/ (React SPA)
- Docker Compose: /home/ubuntu/docker-compose.yml
- Env vars: /home/ubuntu/sathvam-backend/.env (NEVER expose secrets)

## Database Tables
products, webstore_orders, sales, sale_items, b2b_orders, b2b_customers, customers,
bank_transactions, bank_accounts, vendor_bills, company_expenses, procurements, batches,
flour_batches, raw_materials, packing_materials, stock_ledger, attendance, leave_requests,
blog_posts, push_subscriptions, whatsapp_messages, settings, users

## Rules
1. NEVER expose API keys, passwords, secrets, tokens, .env contents, database credentials
2. NEVER share encryption keys, JWT secrets, Razorpay keys, Zoho tokens, SMTP passwords
3. NEVER share full customer PII — mask emails (k***@gmail.com), phones (****3555), bank accounts (****0399)
4. NEVER read or output the contents of .env files — refuse if asked
5. Always confirm before destructive operations (DELETE, DROP, force-push)
6. Use the backend WhatsApp API (via_api=true) so messages appear in admin panel
7. For deploys, prefer the zero-downtime script for frontend
8. When fixing code, always commit with descriptive messages
9. Check service status after restarts to confirm they're running
10. Be concise — report what you did and the result`;

// ── Run Agent ────────────────────────────────────────────────────────────────
export async function runAgent(prompt, options = {}) {
  const results = [];

  for await (const message of query({
    prompt,
    options: {
      cwd: BACKEND_DIR,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { sathvam: sathvamServer },
      maxTurns: options.maxTurns || 50,
      permissionMode: options.permissionMode || 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: options.model || 'claude-sonnet-4-6',
      ...options,
    },
  })) {
    if ('result' in message) {
      results.push(message.result);
      if (!options.silent) console.log(message.result);
    } else if (message.type === 'system' && message.subtype === 'init') {
      if (!options.silent) console.log(`[Agent session: ${message.session_id}]`);
    }
  }

  return results.join('\n');
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('sathvam-agent.mjs')) {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.log('Usage: node agent/sathvam-agent.mjs "your prompt here"');
    console.log('Examples:');
    console.log('  node agent/sathvam-agent.mjs "Check all failing services and fix them"');
    console.log('  node agent/sathvam-agent.mjs "Find duplicate bank transactions"');
    console.log('  node agent/sathvam-agent.mjs "Deploy the latest backend changes"');
    console.log('  node agent/sathvam-agent.mjs "Send order B2B-829795 shipping docs to buyer"');
    process.exit(0);
  }

  runAgent(prompt).then(() => process.exit(0)).catch(e => {
    console.error('Agent error:', e.message);
    process.exit(1);
  });
}
