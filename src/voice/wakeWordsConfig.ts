import { getConfig, type WakeWords } from '../config.js';

export function getWakeWordsFromConfig(): WakeWords {
  return getConfig().settings.voice.wakeWords;
}
