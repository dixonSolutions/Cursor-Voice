/**
 * Intelligence audio routing — WebKit primary, Amazon Polly/Transcribe fallback.
 */

import {
  canUseWebkitStt,
  canUseWebkitTts,
  probeMicAccess,
  webkitSttSkipReason,
} from './webkit-capabilities.js';

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

export function resolveSttBackend(
  config: IntelligenceAudioConfig,
  webkitSttReady = canUseWebkitStt(),
): SttBackend {
  if (config.preferWebkit && webkitSttReady) return 'webkit';
  if (config.amazonAvailable && config.sttFallback === 'amazon_transcribe') {
    return 'amazon_transcribe';
  }
  return 'text_only';
}

export function resolveTtsBackend(config: IntelligenceAudioConfig): TtsBackend {
  if (config.preferWebkit && canUseWebkitTts()) return 'webkit';
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

export interface AudioBackendResolution {
  stt: SttBackend;
  tts: TtsBackend;
  /** Why WebKit STT was not selected, if applicable. */
  sttNote?: string;
}

/** Session init — probe mic after user gesture; fall back to Amazon when WebKit STT unavailable. */
export async function resolveAudioBackendsAsync(
  config: IntelligenceAudioConfig,
): Promise<AudioBackendResolution> {
  const tts = resolveTtsBackend(config);
  let webkitSttReady = canUseWebkitStt();
  let sttNote: string | undefined;

  if (config.preferWebkit && !webkitSttReady) {
    sttNote = webkitSttSkipReason() ?? 'WebKit STT unavailable';
  } else if (config.preferWebkit && webkitSttReady) {
    webkitSttReady = await probeMicAccess();
    if (!webkitSttReady) {
      sttNote = 'Microphone permission denied or no input device';
    }
  }

  const stt = resolveSttBackend(config, webkitSttReady);
  if (stt !== 'webkit' && !sttNote && stt === 'text_only') {
    sttNote = 'No STT backend — configure AWS IAM keys for Amazon Transcribe fallback';
  }

  return { stt, tts, sttNote };
}
