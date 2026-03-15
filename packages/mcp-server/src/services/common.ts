/**
 * common.ts
 * 
 * Common utility functions for services
 */

import { IncomingHttpHeaders } from 'http';

/**
 * Extract headers from MCP context
 * This is useful for getting request-specific information
 */
export function getHeadersFromContext(context: any): IncomingHttpHeaders {
  if (context && context.meta && context.meta.headers) {
    return context.meta.headers as IncomingHttpHeaders;
  }
  return {};
}

/**
 * Format bytes to human-readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Made with Bob
