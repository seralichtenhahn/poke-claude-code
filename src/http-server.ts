#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { PokeTunnel, isLoggedIn, login } from 'poke';
import { ClaudeCodeServer, debugLog } from './server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const POKE_NAME = process.env.POKE_NAME || 'claude-code-mcp';

// Session management: each MCP session gets its own transport + server
const sessions: Record<string, { transport: StreamableHTTPServerTransport; server: ClaudeCodeServer }> = {};

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
        await sessions[sessionId].transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            debugLog(`[HTTP] Session initialized: ${sid}`);
            sessions[sid] = { transport, server: mcpServer };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            debugLog(`[HTTP] Session closed: ${sid}`);
            delete sessions[sid];
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
    console.error('[HTTP] Error handling request:', error);
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
  console.error(`MCP HTTP server listening on http://127.0.0.1:${PORT}/mcp`);
});

// Ensure user is logged in to Poke
if (!isLoggedIn()) {
  console.error('Not logged in to Poke. Starting login flow...');
  await login({ openBrowser: true });
}

const tunnelUrl = `http://127.0.0.1:${PORT}/mcp`;
console.error(`Starting Poke tunnel: ${tunnelUrl}`);

const tunnel = new PokeTunnel({ url: tunnelUrl, name: POKE_NAME });

tunnel.on('connected', (info) => {
  console.error(`Poke tunnel connected!`);
  console.error(`  Tunnel URL: ${info.tunnelUrl}`);
  console.error(`  Local URL:  ${info.localUrl}`);
});

tunnel.on('error', (error) => {
  console.error(`Poke tunnel error: ${error.message}`);
});

tunnel.on('disconnected', () => {
  console.error('Poke tunnel disconnected');
});

tunnel.on('toolsSynced', ({ toolCount }) => {
  debugLog(`[Poke] Tools synced: ${toolCount} tools`);
});

try {
  await tunnel.start();
} catch (error: any) {
  console.error(`Failed to start Poke tunnel: ${error.message}`);
  process.exit(1);
}

// Graceful shutdown
async function shutdown() {
  console.error('Shutting down...');

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
