/**
 * Intelligence audio routing — WebKit primary, Amazon Polly/Transcribe fallback.
 */

import { isWebkitSttSupported } from './webkit-stt.js';
import { isWebkitTtsSupported } from './amazon-tts.js';

export interface IntelligenceAudioConfig {
  preferWebkit: boolean;
  amazonAvailable: boolean;
  sttFallback: 'amazon_transcribe' | null;
  ttsFallback: 'amazon_polly' | null;
  pollyVoiceId?: string;
  transcribeLanguageCode?: string;
}

export type SttBackend = 'webkit' | 'amazon_transcribe' | 'text_only';
export type TtsBackend = 'webkit' | 'amazon_polly' | 'none';

export function resolveSttBackend(config: IntelligenceAudioConfig): SttBackend {
  if (config.preferWebkit && isWebkitSttSupported()) return 'webkit';
  if (config.amazonAvailable && config.sttFallback === 'amazon_transcribe') {
    return 'amazon_transcribe';
  }
  return 'text_only';
}

export function resolveTtsBackend(config: IntelligenceAudioConfig): TtsBackend {
  if (config.preferWebkit && isWebkitTtsSupported()) return 'webkit';
  if (config.amazonAvailable && config.ttsFallback === 'amazon_polly') {
    return 'amazon_polly';
  }
  return 'none';
}

export function describeAudioBackends(config: IntelligenceAudioConfig): {
  stt: SttBackend;
  tts: TtsBackend;
} {
  return {
    stt: resolveSttBackend(config),
    tts: resolveTtsBackend(config),
  };
}
