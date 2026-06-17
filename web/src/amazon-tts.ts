/**
 * Amazon Polly TTS playback — fallback when WebKit speechSynthesis is unavailable.
 */

const MAX_TTS_CHARS = 3000;
let currentAudio: HTMLAudioElement | null = null;

function cleanText(text: string): string {
  return text.replace(/^\[Speak to user\]:\s*/i, '').trim().slice(0, MAX_TTS_CHARS);
}

export function stopAmazonTts(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

export function isWebkitTtsSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.speechSynthesis);
}

/** Fetch Polly MP3 from bridge and play; resolves when playback ends. */
export async function speakAmazonPolly(
  text: string,
  bridgeBase: string,
  appToken: string,
): Promise<void> {
  const clean = cleanText(text);
  if (!clean) return;

  stopAmazonTts();

  const res = await fetch(`${bridgeBase}/api/intelligence/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: clean }),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    throw new Error(`Polly TTS failed: ${detail}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.setAttribute('webkit-playsinline', 'true');
  currentAudio = audio;

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error('Polly audio playback failed'));
    };
    void audio.play().catch(reject);
  });
}
