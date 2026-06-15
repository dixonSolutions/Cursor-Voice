/**
 * Realtime session configuration — system prompt assembly + tool injection.
 *
 * Prompt text lives in prompts/ — referenced by config.json → settings.voice.systemPrompts.
 * This module only substitutes dynamic placeholders at token-mint time.
 *
 * Placeholders:
 *   {{ACTIVATION_RULES}} — activation-rules.md (after wake-word substitution)
 *   {{PROJECT_CATALOG}}  — other registered projects (reference only)
 *   {{ACTIVE_PROJECT}}   — project selected in the app before the call
 *   {{WAKE_START}}       — settings.voice.wakeWords.start
 *
 * See docs/14-prompts.md and docs/13-voice-providers.md.
 */

import { listProjects, getSessionState } from '../state/registry.js';
import { VOICE_FUNCTION_TOOLS } from '../mcp/functionTools.js';
import type { SessionConfig } from './provider.js';
import { getConfig, type VoiceSystemPrompt } from '../config.js';
import type { WakeWords } from './wakeWords.js';

// ── Placeholder assembly ────────────────────────────────────────────────────

function applyWakeWordPlaceholders(text: string, ww: WakeWords): string {
  return text.replaceAll('{{WAKE_START}}', ww.start);
}

function buildActivationRules(ww: WakeWords, template: string): string {
  return applyWakeWordPlaceholders(template, ww);
}

function buildActiveProjectBlock(): string {
  const { activeProject } = getSessionState('default');
  if (!activeProject) {
    return (
      '**None selected** — tell the user to pick a project in the dropdown above the orb, ' +
      'then tap the orb to start a new call.'
    );
  }

  const meta = listProjects().find((p) => p.name === activeProject);
  const desc = meta?.description ? ` — ${meta.description}` : '';
  const aliases =
    meta && meta.aliases.length > 0 ? ` (speech aliases: ${meta.aliases.join(', ')})` : '';
  return `**${activeProject}**${desc}${aliases}`;
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
  return getConfig().settings.voice.wakeWords;
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
      .replace('{{ACTIVE_PROJECT}}', buildActiveProjectBlock())
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
    tools: VOICE_FUNCTION_TOOLS,
    languages: ['en', 'pl'],
  };
}
