import type { AfterViewInit, ElementRef } from '@angular/core';
import {
  Component,
  ViewChild,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';

import type { LogEntry } from '../../services/log.service';
import { LogService } from '../../services/log.service';
import { VoiceSessionService } from '../../services/voice-session.service';

const ITEM_HEIGHT_PX = 28;
const VIEWPORT_HEIGHT_PX = 144;
const OVERSCAN = 3;
/** Within this distance of the bottom, treat scroll as "at bottom" and auto-follow new lines. */
const SCROLL_STICK_EPS_PX = 12;

@Component({
  selector: 'cv-live-log-panel',
  standalone: true,
  imports: [Button, Tag],
  templateUrl: './live-log-panel.component.html',
})
export class LiveLogPanelComponent implements AfterViewInit {
  protected readonly logs = inject(LogService);
  protected readonly voiceSession = inject(VoiceSessionService);

  @ViewChild('viewport') private viewport?: ElementRef<HTMLDivElement>;

  private readonly scrollTop = signal(0);
  private readonly stickToBottom = signal(true);
  private viewReady = false;

  protected readonly visible = computed(
    () =>
      this.voiceSession.sessionPrepActive() ||
      this.voiceSession.sessionConnecting() ||
      this.voiceSession.conversationActive(),
  );

  /** Voice + transcript only — bridge/system logs stay in the Logs tab. */
  protected readonly sessionEntries = computed(() =>
    this.logs.entries().filter(
      (entry) => entry.category === 'voice' || entry.category === 'transcript',
    ),
  );

  protected readonly virtualSlice = computed(() => {
    const entries = this.sessionEntries();
    const scroll = this.scrollTop();
    const start = Math.max(0, Math.floor(scroll / ITEM_HEIGHT_PX) - OVERSCAN);
    const visibleCount = Math.ceil(VIEWPORT_HEIGHT_PX / ITEM_HEIGHT_PX) + OVERSCAN * 2;
    const end = Math.min(entries.length, start + visibleCount);
    return {
      items: entries.slice(start, end),
      startIndex: start,
      totalHeight: entries.length * ITEM_HEIGHT_PX,
      offsetY: start * ITEM_HEIGHT_PX,
    };
  });

  constructor() {
    afterRenderEffect(() => {
      if (!this.viewReady || !this.visible()) return;
      const entries = this.sessionEntries();
      if (entries.length === 0 || !this.stickToBottom()) return;
      // Depend on the latest line so every append triggers a post-render scroll.
      void entries[entries.length - 1]?.id;
      this.scrollToBottom();
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.scrollToBottom();
  }

  protected onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    this.scrollTop.set(el.scrollTop);
    this.stickToBottom.set(el.scrollTop >= maxScroll - SCROLL_STICK_EPS_PX);
  }

  protected clearLogs(): void {
    this.logs.clearVoiceSession();
    this.scrollTop.set(0);
    this.stickToBottom.set(true);
  }

  protected formatTime(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  protected trackEntry(_index: number, entry: LogEntry): number {
    return entry.id;
  }

  private scrollToBottom(): void {
    const el = this.viewport?.nativeElement;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = maxScroll;
    this.scrollTop.set(el.scrollTop);
  }
}
