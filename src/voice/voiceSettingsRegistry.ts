/**
 * Voice settings registry — wake words and turn-submit timing.
 *
 * Persisted in config.json under settings.voice.
 */

import { z } from 'zod';
import {
  getConfig,
  reloadConfig,
  type TurnSubmit,
  type VoiceSettings,
  type VoiceSettingsInput,
  type WakeWords,
} from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { writeAudit } from '../state/db.js';
import { childLogger } from '../log.js';

const log = childLogger('voiceSettings');

export interface VoiceSettingsResponse {
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
}

function persistVoiceUpdate(
  mutate: (voice: VoiceSettingsInput) => void,
  auditReason: string,
): VoiceSettings {
  const file = readConfigFile();
  mutate(file.settings.voice);
  writeConfigFile(file);
  reloadConfig();
  writeAudit({ tool: 'voice_settings', result: 'ok', reason: auditReason });
  log.info({ reason: auditReason }, 'voice settings updated');
  return getConfig().settings.voice;
}

export function getVoiceSettingsView(): VoiceSettingsResponse {
  const { wakeWords, turnSubmit } = getConfig().settings.voice;
  return { wakeWords, turnSubmit };
}

const WakeWordsBodySchema = z.object({
  start: z.string().min(1).max(100),
  end: z.string().max(100).optional(),
  silenceMs: z.coerce.number().int().min(500).max(30_000).optional(),
  vadEnabled: z.boolean().optional(),
});

export function setWakeWords(raw: unknown): VoiceSettingsResponse {
  const parsed = WakeWordsBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid wake phrase — start is required');

  const startTrim = parsed.data.start.trim();
  const endTrim = parsed.data.end?.trim();
  if (!startTrim) throw new Error('Activation phrase cannot be empty');

  persistVoiceUpdate((voice) => {
    voice.wakeWords = {
      start: startTrim,
      end: parsed.data.end !== undefined ? endTrim ?? '' : (voice.wakeWords.end ?? 'send'),
    };
    if (parsed.data.silenceMs !== undefined || parsed.data.vadEnabled !== undefined) {
      voice.turnSubmit = {
        silenceMs: parsed.data.silenceMs ?? voice.turnSubmit.silenceMs,
        vadEnabled: parsed.data.vadEnabled ?? voice.turnSubmit.vadEnabled ?? true,
      };
    }
  }, `wake phrase → start="${startTrim}" end="${endTrim ?? '(unchanged)'}"`);

  return getVoiceSettingsView();
}
