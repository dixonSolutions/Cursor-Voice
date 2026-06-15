/**
 * Browser TTS when Bedrock sends assistant text but no (or broken) audio stream.
 */

const SPEAK_PREFIX = /^\[Speak to user\]:\s*/i;
const MAX_TTS_CHARS = 900;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSpokenText = '';
let lastSpokenAt = 0;
let voicesPrimed = false;

function stripSpeakPrefix(text: string): string {
  return text.replace(SPEAK_PREFIX, '').trim();
}

function textForSpeech(text: string): string {
  const clean = stripSpeakPrefix(text);
  if (clean.length <= MAX_TTS_CHARS) return clean;
  const cut = clean.slice(0, MAX_TTS_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  const body = lastBreak > MAX_TTS_CHARS * 0.4 ? cut.slice(0, lastBreak + 1) : cut;
  return `${body.trimEnd()} …`;
}

/** True for internal reasoning Nova prints instead of user-facing speech. */
function isReasoningMonologue(text: string): boolean {
  const t = text.trim();
  if (SPEAK_PREFIX.test(t)) return false;
  if (t.length > 180 && /^(okay|ok|let'?s see|the user|from the previous|i need to|looking at)/i.test(t)) {
    return true;
  }
  return false;
}

function prepareSpeechSynthesis(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.resume();
  if (!voicesPrimed) {
    window.speechSynthesis.getVoices();
    voicesPrimed = true;
  }
}

/** Speak immediately — browser fallback when Nova sends text without audio. */
export function speakTtsNow(text: string): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  const clean = textForSpeech(text);
  if (!clean || typeof window === 'undefined' || !window.speechSynthesis) return;
  if (clean === lastSpokenText && Date.now() - lastSpokenAt < 10_000) return;

  prepareSpeechSynthesis();
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(clean);
  utter.rate = 1.02;
  utter.onstart = () => {
    lastSpokenAt = Date.now();
    lastSpokenText = clean;
  };
  window.speechSynthesis.speak(utter);
}

/**
 * Fallback when Nova sends plain assistant text without audio.
 */
export function scheduleTtsFallback(text: string, bedrockSpeaking: () => boolean): void {
  const trimmed = text.trim();
  if (!trimmed || typeof window === 'undefined' || !window.speechSynthesis) return;

  if (isReasoningMonologue(trimmed)) return;

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (bedrockSpeaking()) return;
    if (Date.now() - lastSpokenAt < 400) return;
    speakTtsNow(trimmed);
  }, SPEAK_PREFIX.test(trimmed) ? 200 : 800);
}

export function cancelTtsFallback(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export function stopAllTts(): void {
  cancelTtsFallback();
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}
