/**
 * Conversation memory for llm_intelligence — sliding window + summarisation.
 *
 * Cursor stdout is never stored here; always queried fresh via get_status / read_output.
 */

import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { getConfig } from '../config.js';
import { summarizeHistory } from './summarize.js';

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationMemory {
  /** Full turn history for the current session (user + assistant text). */
  turns: TurnMessage[];
  /** Optional summary of older turns after compaction. */
  summary: string | null;
}

export function createMemory(): ConversationMemory {
  return { turns: [], summary: null };
}

export function appendUserTurn(memory: ConversationMemory, text: string): void {
  memory.turns.push({ role: 'user', content: text.trim() });
}

export function appendAssistantTurn(memory: ConversationMemory, text: string): void {
  if (!text.trim()) return;
  memory.turns.push({ role: 'assistant', content: text.trim() });
}

function memorySettings() {
  return getConfig().settings.workflow.llmIntelligence.memory;
}

/** Build Bedrock messages array from memory (summary + recent turns). */
export function buildBedrockMessages(memory: ConversationMemory): Message[] {
  const messages: Message[] = [];

  if (memory.summary) {
    messages.push({
      role: 'user',
      content: [{ text: `[Earlier conversation summary]\n${memory.summary}` }],
    });
    messages.push({
      role: 'assistant',
      content: [{ text: 'Understood — I have the prior context.' }],
    });
  }

  for (const turn of memory.turns) {
    messages.push({
      role: turn.role,
      content: [{ text: turn.content }],
    });
  }

  return messages;
}

/**
 * Compact history when turn count exceeds maxTurns.
 * Calls Claude for a short summary, keeps the last keepTurns turns.
 */
export async function maybeCompactMemory(memory: ConversationMemory): Promise<void> {
  const { maxTurns, keepTurns } = memorySettings();
  if (memory.turns.length <= maxTurns) return;

  const older = memory.turns.slice(0, memory.turns.length - keepTurns);
  const recent = memory.turns.slice(-keepTurns);

  const summary = await summarizeHistory(older, memory.summary);
  memory.summary = summary;
  memory.turns = recent;
}
