import { Injectable, signal } from '@angular/core';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory = 'transcript' | 'voice' | 'bridge' | 'system';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  category: LogCategory;
  summary: string;
  detail?: string;
}

const MAX_ENTRIES = 200;
let _nextId = 0;

@Injectable({ providedIn: 'root' })
export class LogService {
  readonly entries = signal<LogEntry[]>([]);

  append(
    level: LogLevel,
    category: LogCategory,
    summary: string,
    detail?: string,
  ): void {
    const entry: LogEntry = {
      id: _nextId++,
      at: Date.now(),
      level,
      category,
      summary,
      detail,
    };
    this.entries.update((list) => {
      const next = [...list, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }

  transcript(role: 'user' | 'assistant', text: string): void {
    this.append(
      'info',
      'transcript',
      role === 'user' ? `You: ${text}` : text,
    );
  }

  clear(): void {
    this.entries.set([]);
  }

  /** Clear voice/transcript lines from the live session panel only. */
  clearVoiceSession(): void {
    this.entries.update((list) =>
      list.filter((e) => e.category !== 'voice' && e.category !== 'transcript'),
    );
  }
}
