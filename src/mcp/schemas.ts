/**
 * MCP Tool Schemas — single source of truth for all 16 tools.
 *
 * Each tool exports:
 *   - A zod schema for server-side arg validation.
 *   - A JSON schema object for OpenAI function-tool definitions.
 *
 * From these two sources, both the MCP dispatch layer and the provider
 * function-tool definitions are generated (DRY — one definition, two consumers).
 *
 * Full tool specs: docs/11-mcp-tool-surface.md
 */

import { z } from 'zod';

// ── Shared primitives ─────────────────────────────────────────────────────

/** Non-empty string capped at 32 KB (prompt/question text). */
const promptString = z
  .string()
  .min(1, 'Prompt must not be empty')
  .max(32_768, 'Prompt exceeds 32 KB limit');

/** Optional project name (slug-safe). */
const optionalProject = z.string().optional();

// ── Group: Project ────────────────────────────────────────────────────────

export const CursorListProjectsSchema = z.object({
  query: z.string().optional().describe('Filter projects by name, alias, or description'),
});

export const CursorSetProjectSchema = z.object({
  project: z.string().describe('Project name (or alias) to set as the active project'),
});

// ── Group: Model ──────────────────────────────────────────────────────────

export const CursorListModelsSchema = z.object({
  query: z.string().optional().describe('Filter models by id or display name (e.g. "claude", "fast")'),
});

export const CursorSetModelSchema = z.object({
  model_id: z.string().describe('Exact model ID to use (from cursor_list_models)'),
});

// ── Group: Execute ────────────────────────────────────────────────────────

export const CursorSubmitSchema = z.object({
  prompt: promptString.describe("The user's intent — relay with minimal editing"),
  project: optionalProject.describe('Target project (defaults to active project)'),
  mode: z.enum(['agent', 'plan']).optional().describe('Execution mode (default: agent)'),
});

export const CursorAskSchema = z.object({
  question: promptString.describe("The user's question, verbatim"),
  project: optionalProject.describe('Target project (defaults to active project)'),
});

export const CursorRecallAnswerSchema = z.object({
  format: z
    .enum(['brief', 'full'])
    .optional()
    .describe('brief (default) for voice; full for complete text'),
});

// ── Group: Job ────────────────────────────────────────────────────────────

export const CursorStatusSchema = z.object({
  job_id: z.string().uuid('job_id must be a UUID').optional().describe('Defaults to active job'),
});

export const CursorStopSchema = z.object({
  job_id: z.string().uuid('job_id must be a UUID').optional().describe('Defaults to active job'),
});

// ── Group: Session ────────────────────────────────────────────────────────

export const CursorNewSessionSchema = z.object({
  project: optionalProject.describe('Project to clear session for (defaults to active project)'),
});

export const CursorSessionInfoSchema = z.object({
  project: optionalProject.describe('Project to query (defaults to active project)'),
});

// ── Group: Git ────────────────────────────────────────────────────────────

export const CursorDiffSchema = z.object({
  project: optionalProject,
  full_patch: z.boolean().optional().describe('Include full diff patch (default: false, stat only)'),
});

export const CursorRevertSchema = z.object({
  project: optionalProject,
  confirm: z
    .boolean()
    .optional()
    .describe(
      'Must be true for destructive hard-reset. Voice model must confirm with user first.',
    ),
});

// ── Group: System ─────────────────────────────────────────────────────────

export const CursorAgentInfoSchema = z.object({});
export const CursorAgentStatusSchema = z.object({});

// ── Group: MCP Inspect ────────────────────────────────────────────────────

export const CursorMcpListSchema = z.object({});

export const CursorMcpToolsSchema = z.object({
  server: z.string().describe('MCP server identifier (from cursor_mcp_list)'),
});

// ── Schema registry ───────────────────────────────────────────────────────

export const TOOL_SCHEMAS = {
  cursor_list_projects: CursorListProjectsSchema,
  cursor_set_project: CursorSetProjectSchema,
  cursor_list_models: CursorListModelsSchema,
  cursor_set_model: CursorSetModelSchema,
  cursor_submit: CursorSubmitSchema,
  cursor_ask: CursorAskSchema,
  cursor_recall_answer: CursorRecallAnswerSchema,
  cursor_status: CursorStatusSchema,
  cursor_stop: CursorStopSchema,
  cursor_new_session: CursorNewSessionSchema,
  cursor_session_info: CursorSessionInfoSchema,
  cursor_diff: CursorDiffSchema,
  cursor_revert: CursorRevertSchema,
  cursor_agent_info: CursorAgentInfoSchema,
  cursor_agent_status: CursorAgentStatusSchema,
  cursor_mcp_list: CursorMcpListSchema,
  cursor_mcp_tools: CursorMcpToolsSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** Infer the validated arg type for a given tool. */
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[T]>;
