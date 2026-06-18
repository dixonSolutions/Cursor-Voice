/** Voice settings types — mirrors GET /api/voice/providers (no secrets). */

export interface WakeWords {
  start: string;
  end: string;
}

export interface TurnSubmit {
  silenceMs: number;
  vadEnabled?: boolean;
}

export interface VoiceSettingsResponse {
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
}
