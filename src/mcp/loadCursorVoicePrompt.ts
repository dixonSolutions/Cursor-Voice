import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function readCursorVoicePrompt(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').trim();
}

export function cursorVoiceMcpInstructions(): string {
  return readCursorVoicePrompt('prompts/cursor-voice/mcp-instructions.md');
}

export function cursorVoiceRuleBody(): string {
  return readCursorVoicePrompt('prompts/cursor-voice/system.md');
}
