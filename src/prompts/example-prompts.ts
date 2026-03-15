/**
 * example-prompts.ts
 *
 * Example prompts for the MCP server
 * Replace with your actual prompts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerExamplePrompts(server: McpServer) {
  
  server.prompt(
    'example-prompt',
    'Example prompt that demonstrates the basic structure',
    async (args: any) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'This is an example prompt. Replace with your actual prompt content.'
            }
          }
        ]
      };
    }
  );
}

// Made with Bob
