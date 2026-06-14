/**
 * Provider function-tool definitions.
 *
 * Generates the OpenAI function-tool JSON array that gets baked into the
 * ephemeral token request (session config). The voice model sees this as
 * its full capability set — the MCP safety boundary is enforced server-side
 * regardless of what the provider sends.
 *
 * These are defined from the same source as the zod schemas (DRY). When a
 * tool changes in schemas.ts, update the matching entry here.
 *
 * Full tool specs: docs/11-mcp-tool-surface.md
 */

// ── OpenAI function-tool shape ────────────────────────────────────────────

export interface FunctionToolParam {
  type: 'string' | 'boolean' | 'number';
  description?: string;
  enum?: string[];
}

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, FunctionToolParam>;
    required: string[];
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────

export const FUNCTION_TOOLS: FunctionTool[] = [
  // ── Project ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_list_projects',
    description:
      'List all available projects the user can work on. Optional query filters by name, alias, or description. Use to discover projects or when the user asks "what can I work on?".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter term (name, alias, or description)' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_set_project',
    description:
      'Set the active project for the session. Read back the project name and description after setting to confirm with the user.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or alias' },
      },
      required: ['project'],
    },
  },

  // ── Model ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_list_models',
    description:
      'List available AI models. Optional query filters (e.g. "claude", "fast", "thinking"). Use when the user asks what models are available or wants to pick one.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by model id or display name' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_set_model',
    description:
      'Set the active model for cursor-agent. Call cursor_list_models first to get valid IDs. The model is used for all subsequent cursor_submit calls.',
    parameters: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Exact model ID from cursor_list_models' },
      },
      required: ['model_id'],
    },
  },

  // ── Execute ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_submit',
    description:
      'Submit a coding task to cursor-agent. Returns a job_id immediately — use cursor_status to track progress. Only call this when the task is clearly defined and the project is confirmed.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Concrete task description for cursor-agent. Be specific.',
        },
        project: {
          type: 'string',
          description: 'Target project (omit to use the active project)',
        },
        mode: {
          type: 'string',
          enum: ['agent', 'plan'],
          description: 'agent = apply changes immediately; plan = propose a plan without applying',
        },
      },
      required: ['prompt'],
    },
  },
  {
    type: 'function',
    name: 'cursor_ask',
    description:
      'Read-only repo Q&A — ask cursor-agent a question about the codebase without making changes. Use BEFORE drafting cursor_submit when you need facts about the code.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question about the codebase' },
        project: {
          type: 'string',
          description: 'Target project (omit to use the active project)',
        },
      },
      required: ['question'],
    },
  },

  // ── Job ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_status',
    description:
      'Check the status and progress of a running or completed job. Returns status (running/done/error/stopped), summary, and progress events.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID from cursor_submit' },
      },
      required: ['job_id'],
    },
  },
  {
    type: 'function',
    name: 'cursor_stop',
    description: 'Stop a running cursor-agent job. Use when the user asks to cancel or abort.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID to stop' },
      },
      required: ['job_id'],
    },
  },

  // ── Session ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_new_session',
    description:
      'Start a fresh cursor-agent conversation thread for a project. Use when the user wants to start over, change direction, or the previous context is stale.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_session_info',
    description:
      'Get the current session state for a project: resume ID, last job, last run time. Use to narrate "you were last working on X N minutes ago".',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
      },
      required: [],
    },
  },

  // ── Git ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_diff',
    description:
      'Show the current uncommitted changes in the project. Returns a summary stat and optionally the full patch. Use when the user asks "what changed?" or "show me the diff".',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
        full_patch: {
          type: 'boolean',
          description: 'Include the full diff text (default: false, stat only)',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_revert',
    description:
      'Undo all changes made by the last cursor-agent job. For uncommitted changes: safe stash (reversible). For committed changes: hard reset (destructive — confirm with the user first, then set confirm=true).',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
        confirm: {
          type: 'boolean',
          description: 'Required true for destructive hard-reset. Get explicit user confirmation first.',
        },
      },
      required: [],
    },
  },

  // ── System ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_agent_info',
    description:
      'Get cursor-agent version, model, and system info. Use when the user asks "what version is Cursor?" or for diagnostics.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cursor_agent_status',
    description: 'Check if cursor-agent is authenticated. Returns auth status and account email.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── MCP Inspect ───────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_mcp_list',
    description: "List MCP servers configured in cursor-agent's .cursor/mcp.json (for debugging).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cursor_mcp_tools',
    description: 'List tools for a specific cursor-agent MCP server (for debugging).',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server identifier from cursor_mcp_list' },
      },
      required: ['server'],
    },
  },
];

/** Build a lookup map by tool name. */
export const FUNCTION_TOOL_MAP = new Map(FUNCTION_TOOLS.map((t) => [t.name, t]));
