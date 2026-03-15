/**
 * mcp-server.ts
 * 
 * homehub MCP Server - Factory to create and configure MCP server instances
 */

import { IncomingHttpHeaders } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExampleTool } from './tools/exampleTool';
import { registerExamplePrompts } from './prompts/example-prompts';

/**
 * Factory to create and configure a new McpServer
 *
 * @param initialHeaders - HTTP headers from the initial request
 * @returns Configured McpServer instance
 */
export function createMcpServer(initialHeaders: IncomingHttpHeaders): McpServer {
  
  /**
   * ============================================================================
   * MCP SERVER INSTRUCTIONS FOR AI ASSISTANTS
   * ============================================================================
   *
   * You are an assistant with access to the homehub MCP server.
   *
   * USE THIS SERVER FOR:
   * - [Add your use cases here]
   *
   * KEYWORDS THAT INDICATE THIS SERVER:
   * "[Add relevant keywords here]"
   *
   * CAPABILITIES:
   * - [List your tools and their purposes]
   *
   * IMPORTANT GUIDELINES:
   * - [Add any important guidelines for using this server]
   *
   * Always provide clear and actionable insights from the data.
   * ============================================================================
   */
  
  // Create a new MCP server with proper configuration
  const server = new McpServer(
    {
      name: 'homehub',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools:     { listChanged: true },
        resources: { listChanged: true },
        prompts:   { listChanged: true }
      }
    }
  );
  
  // Register tools
  registerExampleTool(server);
  
  // Register prompts
  registerExamplePrompts(server);
  
  // Add status resource
  server.resource(
    'server-status',
    'status://server',
    async (uri: URL) => {
      const statusText = `homehub Status:

Server Version: 1.0.0
Timestamp: ${new Date().toISOString()}

Status: Operational`;
      
      return {
        contents: [
          {
            uri: uri.href,
            text: statusText
          }
        ]
      };
    }
  );
  
  return server;
}

// Made with Bob
