/**
 * exampleTool.ts
 *
 * Example tool implementation
 * Replace this with your actual tool implementation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerExampleTool(server: McpServer) {
  const toolName = 'example-tool';
  const toolDescription = `
    Example tool that demonstrates the basic structure.
    
    Replace this with your actual tool description.
  `;
  
  const toolSchema = {
    message: z.string().describe('A message to process')
  };
  
  const toolCallback = async (params: any): Promise<any> => {
    try {
      const { message } = params;
      
      // Your tool logic here
      return {
        content: [
          {
            type: 'text',
            text: `Processed message: ${message}`
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  };
  
  server.tool(toolName, toolDescription, toolSchema, toolCallback);
}

// Made with Bob
