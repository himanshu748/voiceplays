import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { despeak, listProcedures, rank, speakable } from './procedures.js';
import { getJob, runningCount, startJob, stopAll } from './jobs.js';
import { configureAuth } from './auth.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOW_WRITES = new Set((process.env.VOICEPLAYS_ALLOW_WRITES ?? '').split(',').map(s => s.trim()).filter(Boolean));
const APPROVED_REGISTRY = new Set((process.env.VOICEPLAYS_APPROVED_REGISTRY ?? '').split(',').map(s => s.trim()).filter(Boolean));
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 15 * 60 * 1000);
const MAX_RUNNING = Number(process.env.MAX_RUNNING ?? 3);
const CONFIRM_TTL_MS = 2 * 60 * 1000;

const auth = configureAuth(process.env);
if (auth.problems) {
  for (const p of auth.problems) console.error(p);
  process.exit(1);
}

// The MCP client can set any argument it likes, so a `confirmed: true` flag
// proves nothing. The server issues a short code that only reaches the caller
// by first asking, which forces a separate turn before anything that makes
// changes runs. It cannot prove a human spoke; the write allowlist is the
// real limit.
const pendingConfirmations = new Map();

function say(text, isError = false) {
  const result = { content: [{ type: 'text', text: speakable(text) }] };
  if (isError) result.isError = true;
  return result;
}

// Keep the last few lines that still say something once terminal decoration is
// gone, so a progress bar never becomes the spoken answer.
function summarise(output, lines) {
  return String(output)
    .split('\n')
    .map(despeak)
    .filter(l => l.length > 1)
    .slice(-lines)
    .join(', ');
}

function seconds(ms) {
  return Math.max(1, Math.round(ms / 1000));
}

function buildServer() {
  const server = new McpServer(
    { name: 'voiceplays', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'find_procedure',
    {
      title: 'Find a saved procedure',
      description:
        'Search the saved procedures by a spoken phrase. Returns up to three candidates, ' +
        'each marked when it is not known to be read-only or needs information the caller ' +
        'must supply. Call this before start_procedure whenever the request does not name ' +
        'a procedure exactly.',
      inputSchema: {
        phrase: z.string().max(200).describe('What the person asked for, in their own words.')
      }
    },
    async ({ phrase }) => {
      const all = await listProcedures();
      const hits = rank(all, phrase).slice(0, 3);
      if (hits.length === 0) {
        return say(`Nothing matches "${phrase}". There are ${all.length} saved procedures.`);
      }
      const describe = h => {
        const notes = [];
        if (!h.readOnly) notes.push('not marked read-only');
        if (h.requiredParams.length) notes.push(`needs ${h.requiredParams.join(' and ')}`);
        return notes.length ? `${h.name} (${notes.join(', ')})` : h.name;
      };
      return say(
        hits.length === 1
          ? `One match: ${describe(hits[0])}.`
          : `Best match ${describe(hits[0])}. Also ${hits.slice(1).map(describe).join(', ')}.`
      );
    }
  );

  server.registerTool(
    'start_procedure',
    {
      title: 'Start a saved procedure',
      description:
        'Start one saved procedure by its exact name. Returns immediately; the procedure ' +
        'keeps running in the background. Call procedure_result later to hear how it went. ' +
        'A procedure that is not marked read-only runs only if the owner enabled it for ' +
        'voice, and only with the confirmation code this tool returns on the first attempt. ' +
        'Read that code to the person and pass it back only after they agree out loud.',
      inputSchema: {
        name: z.string().max(200).describe('Exact procedure name, as returned by find_procedure.'),
        confirmation: z.string().max(10).optional()
          .describe('The code returned by an earlier start_procedure call for this procedure.')
      }
    },
    async ({ name, confirmation }) => {
      const play = (await listProcedures()).find(p => p.name === name);
      if (!play) return say(`There is no saved procedure called ${name}.`, true);

      // A required parameter cannot be filled from a voice turn, and the play
      // would exit before its first step. Refuse with the reason instead.
      if (play.requiredParams.length > 0) {
        return say(`I cannot run ${name} by voice. It needs ${play.requiredParams.join(' and ')} supplied first.`, true);
      }

      // rote asks for approval before running a registry play, and a voice turn
      // cannot answer that prompt. The owner pre-approves registry plays here.
      const fromRegistry = play.source !== 'local';
      if (fromRegistry && !APPROVED_REGISTRY.has(name)) {
        return say(`${name} comes from the registry and has not been approved for voice.`, true);
      }

      if (!play.readOnly) {
        if (!ALLOW_WRITES.has(name)) {
          return say(`${name} is not marked read-only, and it has not been enabled for voice.`, true);
        }
        const pending = pendingConfirmations.get(name);
        const valid = pending && Date.now() < pending.expires && confirmation === pending.code;
        if (!valid) {
          const code = String(randomInt(1000, 10000));
          pendingConfirmations.set(name, { code, expires: Date.now() + CONFIRM_TTL_MS });
          return say(`${name} is not marked read-only. If the person agrees, start it again with confirmation code ${code}.`, true);
        }
        pendingConfirmations.delete(name);
      }

      const existing = getJob(name);
      if (existing?.state === 'running') {
        return say(`${name} is already running. It started ${seconds(Date.now() - existing.startedAt)} seconds ago.`);
      }
      if (runningCount() >= MAX_RUNNING) {
        return say(`${MAX_RUNNING} procedures are already running. Try again when one finishes.`, true);
      }

      startJob(name, JOB_TIMEOUT_MS, { approved: fromRegistry });
      return say(`Started ${name}. Ask me for the result in a little while.`);
    }
  );

  server.registerTool(
    'procedure_result',
    {
      title: 'Hear how a procedure went',
      description:
        'Report the state of the most recent run of a procedure started with ' +
        'start_procedure: still running, finished, failed or stopped for taking too long.',
      inputSchema: {
        name: z.string().max(200).describe('Exact procedure name.')
      }
    },
    async ({ name }) => {
      const job = getJob(name);
      if (!job) return say(`${name} has not been started since I came online.`);
      const elapsed = seconds((job.endedAt ?? Date.now()) - job.startedAt);
      switch (job.state) {
        case 'running':
          return say(`${name} is still running, ${elapsed} seconds so far.`);
        case 'finished':
          return say(`${name} finished in ${elapsed} seconds. ${summarise(job.output, 3)}`);
        case 'timed-out':
          return say(`${name} was still running after ${seconds(JOB_TIMEOUT_MS)} seconds, so I stopped it.`, true);
        default:
          return say(`${name} failed after ${elapsed} seconds. ${summarise(job.output, 2)}`, true);
      }
    }
  );

  return server;
}

// Host validation stays on even when bound beyond localhost, so a page in a
// browser cannot reach this server through DNS rebinding.
const app = createMcpExpressApp({
  host: HOST,
  allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...(auth.publicHostname ? [auth.publicHostname] : [])]
});

app.use(auth.router);

app.post('/mcp', async (req, res) => {
  // Stateless: a fresh server and transport per request, so a dropped voice
  // session never strands state on this process. Jobs live outside it.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.all('/mcp', (req, res) => {
  res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null
  });
});

app.listen(PORT, HOST, () => {
  console.log(`voiceplays MCP server on http://${HOST}:${PORT}/mcp`);
  console.log(auth.oauth ? 'auth: OAuth client_credentials enabled' : 'auth: static token only');
  if (ALLOW_WRITES.size) console.log(`voice-enabled procedures that make changes: ${[...ALLOW_WRITES].join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopAll(); process.exit(0); });
}
