/**
 * Load voice system prompts from prompts/systemprompts.json + referenced markdown files.
 *
 * Manifest supports modular messenger sections (ordered .md files) or a legacy single template.
 *
 * See docs/14-prompts.md.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { type VoiceSystemPrompt } from '../config.js';

const PromptManifestSchema = z
  .object({
    activationRules: z.string().min(1),
    /** Legacy: one file containing the full messenger body. */
    template: z.string().min(1).optional(),
    /** Modular: ordered section files joined at load time. */
    messenger: z.array(z.string().min(1)).optional(),
  })
  .refine((m) => Boolean(m.template) || (m.messenger?.length ?? 0) > 0, {
    message: 'Prompt manifest needs "template" or non-empty "messenger" array',
  });

const DEFAULT_SYSTEM_PROMPTS = ['prompts/systemprompts.json'];

function readPromptFile(baseDir: string, relativePath: string): string {
  const filePath = resolve(baseDir, relativePath);
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8').trim();
}

function loadMessengerTemplate(manifestDir: string, manifest: z.infer<typeof PromptManifestSchema>): string {
  if (manifest.messenger?.length) {
    return manifest.messenger
      .map((rel) => readPromptFile(manifestDir, rel))
      .join('\n\n');
  }
  return readPromptFile(manifestDir, manifest.template!);
}

/** Load a single systemprompts manifest and its referenced markdown files. */
export function loadSystemPromptManifest(manifestPath: string): VoiceSystemPrompt {
  const absManifest = resolve(manifestPath);
  if (!existsSync(absManifest)) {
    throw new Error(`System prompt manifest not found: ${absManifest}`);
  }

  const manifestDir = dirname(absManifest);
  const raw = JSON.parse(readFileSync(absManifest, 'utf-8')) as unknown;
  const manifest = PromptManifestSchema.parse(raw);

  return {
    activationRules: readPromptFile(manifestDir, manifest.activationRules),
    template: loadMessengerTemplate(manifestDir, manifest),
  };
}

/**
 * Resolve settings.voice.systemPrompts paths relative to the config.json directory.
 * Uses the first manifest entry (extensible for future multi-prompt packs).
 */
export function loadVoiceSystemPrompt(configPath: string, systemPrompts?: string[]): VoiceSystemPrompt {
  const configDir = dirname(resolve(configPath));
  const paths = systemPrompts?.length ? systemPrompts : DEFAULT_SYSTEM_PROMPTS;
  const manifestPath = join(configDir, paths[0]!);
  return loadSystemPromptManifest(manifestPath);
}

export { DEFAULT_SYSTEM_PROMPTS };
