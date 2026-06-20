/**
 * MCP tool registration wrapper — logs tool calls to live session logs on the PWA.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  broadcastSessionLog,
  summarizeToolArgs,
  summarizeToolResult,
} from './sessionLog.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Wrap server.tool so every MCP invocation emits session_log events (call + result/error).
 * Call once at the start of buildMcpServer before registering tools.
 */
export function instrumentMcpToolLogging(server: McpServer): void {
  const target = server as McpServer & {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: ToolHandler,
    ) => unknown;
  };
  const original = target.tool.bind(target);

  // MCP SDK tool() overloads confuse TS when reassigned — runtime wrapper is correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target as any).tool = (name: string, description: string, schema: unknown, handler: ToolHandler) =>
    original(name, description, schema, async (args: Record<string, unknown>) => {
      const argSummary = summarizeToolArgs(name, args);
      broadcastSessionLog({
        subcategory: 'tool',
        level: 'info',
        summary: `→ ${name}`,
        ...(argSummary ? { detail: argSummary } : {}),
      });

      try {
        const result = await handler(args);
        const resultSummary = summarizeToolResult(name, result);
        broadcastSessionLog({
          subcategory: 'tool',
          level: 'info',
          summary: `← ${name}`,
          detail: resultSummary,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        broadcastSessionLog({
          subcategory: 'tool',
          level: 'error',
          summary: `${name} failed`,
          detail: message.slice(0, 200),
        });
        throw err;
      }
    });
}
