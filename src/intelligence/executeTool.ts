/**
 * Execute intelligence workflow tool calls — bridge constraints per tool.
 */

import { dispatchTool } from '../mcp/handlers.js';
import { childLogger } from '../log.js';
import { getConfig } from '../config.js';
import {
  INTELLIGENCE_TOOL_ALIASES,
  isBridgeHandledTool,
  SPEAK_TOOL_NAME,
} from './tools.js';
import { trimForLlm } from './trimOutput.js';

const log = childLogger('intelligence:execute');

export interface ToolExecutionCallbacks {
  onSpeak: (text: string) => void;
  onToolActivity?: (tool: string, phase: 'start' | 'done' | 'error', detail?: string) => void;
}

export interface ToolExecutionResult {
  toolUseId: string;
  content: string;
  /** Assistant-visible text extracted from speak() calls this turn. */
  spokenTexts: string[];
}

function mapToolArgs(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name === 'launch_agent') {
    return {
      prompt: input['task'] ?? input['prompt'],
      mode: input['mode'],
    };
  }
  if (name === 'read_output' || name === 'get_status') {
    return { job_id: input['job_id'] };
  }
  return input;
}

export async function executeIntelligenceTool(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  sessionKey: string,
  callbacks: ToolExecutionCallbacks,
): Promise<ToolExecutionResult> {
  const spokenTexts: string[] = [];

  if (isBridgeHandledTool(name)) {
    const text = String(input['text'] ?? '').trim();
    if (text) {
      callbacks.onSpeak(text);
      spokenTexts.push(text);
    }
    return {
      toolUseId,
      content: JSON.stringify({ ok: true, spoken: Boolean(text) }),
      spokenTexts,
    };
  }

  const mcpName = INTELLIGENCE_TOOL_ALIASES[name] ?? name;
  const args = mapToolArgs(name, input);
  const maxChars = getConfig().settings.workflow.llmIntelligence.readOutputMaxChars;

  callbacks.onToolActivity?.(name, 'start');
  try {
    const raw = await dispatchTool(mcpName, args, sessionKey);
    const trimmed = trimForLlm(raw, maxChars);
    callbacks.onToolActivity?.(name, 'done');
    return {
      toolUseId,
      content: JSON.stringify(trimmed),
      spokenTexts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ tool: name, err: message }, 'intelligence tool failed');
    callbacks.onToolActivity?.(name, 'error', message);
    return {
      toolUseId,
      content: JSON.stringify({ error: message }),
      spokenTexts,
    };
  }
}

export { SPEAK_TOOL_NAME };
