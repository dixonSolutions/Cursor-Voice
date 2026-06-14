/**
 * Realtime session configuration — system prompt assembly + tool injection.
 *
 * Prompt text lives in config.json → settings.voice.systemPrompt (editable).
 * This module only substitutes dynamic placeholders at token-mint time.
 *
 * Placeholders:
 *   {{ACTIVATION_RULES}} — from systemPrompt.activationRules (+ wake words)
 *   {{PROJECT_CATALOG}}  — project names/aliases from the registry
 *   {{WAKE_START}}       — settings.voice.wakeWords.start
 *   {{WAKE_STOP}}        — settings.voice.wakeWords.stop
 *
 * See docs/13-voice-providers.md — Voice system prompt section.
 */

import { listProjects } from '../state/registry.js';
import { FUNCTION_TOOLS } from '../mcp/functionTools.js';
import type { SessionConfig } from './provider.js';
import { getConfig, type VoiceSystemPrompt } from '../config.js';
import { DEFAULT_WAKE_WORDS, type WakeWords } from './wakeWords.js';

// ── Placeholder assembly ────────────────────────────────────────────────────

function applyWakeWordPlaceholders(text: string, ww: WakeWords): string {
  return text.replaceAll('{{WAKE_START}}', ww.start).replaceAll('{{WAKE_STOP}}', ww.stop);
}

function buildActivationRules(ww: WakeWords, template: string): string {
  return applyWakeWordPlaceholders(template, ww);
}

/** Build the project catalog block injected into the system prompt. */
function buildProjectCatalog(): string {
  const projects = listProjects();
  if (projects.length === 0) {
    return 'No projects are currently registered.';
  }

  return projects
    .map((p) => {
      const aliases = p.aliases.length > 0 ? ` (also: ${p.aliases.join(', ')})` : '';
      return `  • **${p.name}**${aliases}`;
    })
    .join('\n');
}

export function getWakeWordsFromConfig(): WakeWords {
  return getConfig().settings.voice.wakeWords ?? DEFAULT_WAKE_WORDS;
}

export function getSystemPromptFromConfig(): VoiceSystemPrompt {
  return getConfig().settings.voice.systemPrompt;
}

/** Assemble the full system prompt with catalog and wake words injected. */
export function buildSystemPrompt(wakeWords?: WakeWords): string {
  const ww = wakeWords ?? getWakeWordsFromConfig();
  const { activationRules, template } = getSystemPromptFromConfig();
  const catalog = buildProjectCatalog();
  const activationBlock = buildActivationRules(ww, activationRules);

  return applyWakeWordPlaceholders(
    template
      .replace('{{ACTIVATION_RULES}}', activationBlock)
      .replace('{{PROJECT_CATALOG}}', catalog),
    ww,
  );
}

// ── Session config builder ────────────────────────────────────────────────

/**
 * Build the session config to pass to provider.mintEphemeralToken().
 * Called fresh on every token mint to pick up config or catalog changes.
 */
export function buildSessionConfig(voice: string = 'alloy'): SessionConfig {
  return {
    instructions: buildSystemPrompt(),
    voice,
    tools: FUNCTION_TOOLS,
    languages: ['en', 'pl'],
  };
}
