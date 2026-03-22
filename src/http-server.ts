#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { PokeTunnel, isLoggedIn, login } from 'poke';
import { ClaudeCodeServer } from './server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const POKE_NAME = process.env.POKE_NAME || 'claude-code-mcp';

// Session management: each MCP session gets its own transport + server
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes idle timeout
const sessions: Record<string, { transport: StreamableHTTPServerTransport; server: ClaudeCodeServer; lastActivity: number }> = {};

function sessionCount(): number {
  return Object.keys(sessions).length;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.error(`${ts} ${msg}`);
}

// Clean up idle sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of Object.entries(sessions)) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      session.transport.close();
      delete sessions[sid];
      log(`session ${sid.slice(0, 8)} expired  (${sessionCount()} active)`);
    }
  }
}, 60_000);

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions[sessionId]) {
        sessions[sessionId].lastActivity = Date.now();
        await sessions[sessionId].transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions[sid] = { transport, server: mcpServer, lastActivity: Date.now() };
            log(`session ${sid.slice(0, 8)} opened  (${sessionCount()} active)`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            delete sessions[sid];
            log(`session ${sid.slice(0, 8)} closed  (${sessionCount()} active)`);
          }
        };

        const mcpServer = new ClaudeCodeServer();
        await mcpServer.run(transport);
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        }));
      }
    } else if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions[sessionId]) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid or missing session ID');
        return;
      }
      await sessions[sessionId].transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions[sessionId]) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid or missing session ID');
        return;
      }
      await sessions[sessionId].transport.handleRequest(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  } catch (error) {
    log(`request error: ${error}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }));
    }
  }
});

// Start HTTP server, then Poke tunnel
httpServer.listen(PORT, '127.0.0.1', () => {
  log(`server listening on http://127.0.0.1:${PORT}/mcp`);
});

// Ensure user is logged in to Poke
if (!isLoggedIn()) {
  log('not logged in to Poke — opening browser...');
  await login({ openBrowser: true });
}

const tunnelUrl = `http://127.0.0.1:${PORT}/mcp`;
log(`connecting Poke tunnel → ${tunnelUrl}`);

const tunnel = new PokeTunnel({ url: tunnelUrl, name: POKE_NAME });



tunnel.on('connected', (info) => {
  log(`tunnel connected`);
  log(`  remote: ${info.tunnelUrl}`);
  log(`  local:  ${info.localUrl}`);
});

tunnel.on('error', (error) => {
  log(`tunnel error: ${error.message}`);
});

tunnel.on('disconnected', () => {
  log('tunnel disconnected');
});

tunnel.on('toolsSynced', ({ toolCount }) => {
  log(`tools synced (${toolCount} tools)`);
});

try {
  await tunnel.start();
} catch (error: any) {
  log(`failed to start tunnel: ${error.message}`);
  process.exit(1);
}

// Graceful shutdown
async function shutdown() {
  log('shutting down...');

  await tunnel.stop();

  for (const sessionId of Object.keys(sessions)) {
    try {
      await sessions[sessionId].transport.close();
      delete sessions[sessionId];
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  }

  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
