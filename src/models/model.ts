import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { IncomingHttpHeaders } from 'http';

/**
 * Session entry for managing MCP server sessions
 */
export interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  latestHeaders?: IncomingHttpHeaders;
}

// Add your custom models here
// Example:
// export interface YourModel {
//   id: string;
//   name: string;
//   // ... other fields
// }

// Made with Bob
