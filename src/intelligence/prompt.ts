/**
 * System prompt assembly for the llm_intelligence orchestrator.
 *
 * Uses prompts/llm-intelligence/ manifest from config.json → settings.workflow.llmIntelligence.
 */

import { listProjects, getSessionState } from '../state/registry.js';
import { getConfig } from '../config.js';
import { getWakeWordsFromConfig } from '../voice/wakeWordsConfig.js';

function applyWakeWordPlaceholders(text: string, start: string): string {
  return text.replaceAll('{{WAKE_START}}', start);
}

function buildActiveProjectBlock(): string {
  const { activeProject } = getSessionState('default');
  if (!activeProject) {
    return (
      '**None selected** — tell the user to pick a project in the dropdown above the orb, ' +
      'then tap the orb to start a new session.'
    );
  }

  const meta = listProjects().find((p) => p.name === activeProject);
  const desc = meta?.description ? ` — ${meta.description}` : '';
  const aliases =
    meta && meta.aliases.length > 0 ? ` (speech aliases: ${meta.aliases.join(', ')})` : '';
  return `**${activeProject}**${desc}${aliases}`;
}

function buildProjectCatalog(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No projects are currently registered.';

  return projects
    .map((p) => {
      const aliases = p.aliases.length > 0 ? ` (also: ${p.aliases.join(', ')})` : '';
      return `  • **${p.name}**${aliases}`;
    })
    .join('\n');
}

/** Full orchestrator system prompt with placeholders resolved. */
export function buildIntelligenceSystemPrompt(): string {
  const { activationRules, template } = getConfig().settings.workflow.llmIntelligence.systemPrompt;
  const { start } = getWakeWordsFromConfig();
  const activationBlock = applyWakeWordPlaceholders(activationRules, start);

  return applyWakeWordPlaceholders(
    template
      .replace('{{ACTIVATION_RULES}}', activationBlock)
      .replace('{{ACTIVE_PROJECT}}', buildActiveProjectBlock())
      .replace('{{PROJECT_CATALOG}}', catalogBlock()),
    start,
  );
}

function catalogBlock(): string {
  return buildProjectCatalog();
}
