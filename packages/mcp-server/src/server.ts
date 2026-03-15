/**
 * server.ts
 *
 * homehub MCP Server (Streamable HTTP, Stateful)
 */

import log4js from 'log4js';
import express from "express";
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';
import { SessionEntry } from './models/model';
import { createMcpServer } from './mcp-server';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

/**
 * In-memory session store:
 *   sessions[sessionId] = {
 *     server:   McpServer instance for this session,
 *     transport: StreamableHTTPServerTransport bound to this session
 *   }
 */
const sessions: Record<string, SessionEntry> = {};

const l = log4js.getLogger();

const MCP_PATH = '/mcp';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    l.debug(`> ${req.method} ${req.originalUrl}`);
    l.debug(req.body);
    return next();
});

// ── Bearer auth on /mcp (skip health checks) ──────────────────
app.use(MCP_PATH, (req, res, next) => {
  const secret = process.env.MCP_SECRET;
  if (!secret) return next(); // auth disabled in dev if MCP_SECRET not set

  const auth = req.headers['authorization'] ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== secret) {
    res.status(401).json({ error: 'Unauthorized', code: 'INVALID_MCP_SECRET' });
    return;
  }
  return next();
});

// Handle GET requests for server-to-client notifications via SSE
app.get(MCP_PATH, (req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

// Handle DELETE requests for session termination
app.delete(MCP_PATH, (req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

/**
 * Handler for POST /mcp:
 *   1. If "mcp-session-id" header exists and matches a stored session, reuse that session.
 *   2. If no "mcp-session-id" and request is initialize, create new session and handshake.
 *   3. Otherwise, return a 400 error.
 */
app.post(MCP_PATH, async (req, res) => {
  const sessionIdHeader = req.headers['mcp-session-id'];
  let sessionEntry = null;

  // Case 1: Existing session found
  const sessionId =
    typeof sessionIdHeader === 'string'
      ? sessionIdHeader
      : Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : undefined;

  if (sessionId && sessions[sessionId]) {
    sessionEntry = sessions[sessionId];

  // Case 2: Initialization request → create new transport + server
  } else if (!sessionIdHeader && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    const initialHeaders = {...req.headers};

    // Create a new transport for this session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid: string) => {
        // Store the Transport and Server instance once session is initialized
        sessions[sid] = { server, transport, latestHeaders: initialHeaders};
      }
    });

    // Create and configure the new McpServer
    const server = createMcpServer(initialHeaders);
    
    // When this transport closes, clean up the session entry
    transport.onclose = () => {
      if (transport.sessionId && sessions[transport.sessionId]) {
        delete sessions[transport.sessionId];
      }
    };
    
    // Type assertion to satisfy exactOptionalPropertyTypes requirement
    // The transport has onclose defined above, so this is safe
    await server.connect(transport as any);

    // After `onsessioninitialized` fires, `sessions[newSessionId]` is set.
    // But we can also assign it here for immediate access.
    sessions[newSessionId] = { server, transport };
    sessionEntry = sessions[newSessionId];

  } else {
    // Neither a valid session nor an initialize request → return error
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null
    });
    return;
  }

  // Forward the request to the transport of the retrieved/created session
  await sessionEntry.transport.handleRequest(req, res, req.body);
});

/**
 * Handler for GET/DELETE /mcp:
 *   Used for server-to-client notifications (SSE) and session termination.
 */
async function handleSessionRequest(req: Request, res: Response) {
  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId =
    typeof sessionIdHeader === 'string'
      ? sessionIdHeader
      : Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : undefined;
  if (!sessionId || !sessions[sessionId]) {
    res.statusCode = 400;
    res.send('Invalid or missing session ID');
    return;
  }
  const { transport } = sessions[sessionId];
  await transport.handleRequest(req, res);
}

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

// Health check endpoints
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'mcp-server', version: '1.0.0' });
});
app.get('/mcp/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'mcp-server', version: '1.0.0' });
});

// Start the server using PORT from environment variables
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`homehub MCP Server listening on port: ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  l.info('SIGTERM received, shutting down MCP server');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});
