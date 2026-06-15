import { Injectable, inject, signal } from '@angular/core';
import { BridgeService } from './bridge.service';
import type { ProviderId, VoiceProvidersResponse } from '../models/voice-providers';

/**
 * Voice provider settings — loads and mutates /api/voice/* endpoints.
 * Keys are write-only from the web app's perspective.
 */
@Injectable({ providedIn: 'root' })
export class VoiceProvidersService {
  private readonly bridge = inject(BridgeService);

  readonly data = signal<VoiceProvidersResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.apiFetch<VoiceProvidersResponse>('/api/voice/providers');
      this.data.set(res);
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async register(id: ProviderId): Promise<void> {
    await this.mutate('/api/voice/providers', { method: 'POST', body: JSON.stringify({ id }) });
  }

  async unregister(id: ProviderId): Promise<void> {
    await this.mutate(`/api/voice/providers/${id}`, { method: 'DELETE' });
  }

  async setDefaultProvider(id: ProviderId): Promise<void> {
    await this.mutate('/api/voice/default-provider', {
      method: 'PUT',
      body: JSON.stringify({ id }),
    });
  }

  async setDefaultModel(providerId: ProviderId, modelId: string): Promise<void> {
    await this.mutate(`/api/voice/providers/${providerId}/default-model`, {
      method: 'PATCH',
      body: JSON.stringify({ modelId }),
    });
  }

  async addModel(providerId: ProviderId, id: string, label?: string): Promise<void> {
    await this.mutate(`/api/voice/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify({ id, label: label || undefined }),
    });
  }

  async removeModel(providerId: ProviderId, modelId: string): Promise<void> {
    await this.mutate(`/api/voice/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
    });
  }

  async updateKeys(providerId: ProviderId, keys: Record<string, string>): Promise<void> {
    await this.mutate(`/api/voice/providers/${providerId}/keys`, {
      method: 'PUT',
      body: JSON.stringify({ keys }),
    });
  }

  async updateWakeWords(start: string): Promise<void> {
    await this.mutate('/api/voice/wake-words', {
      method: 'PATCH',
      body: JSON.stringify({ start }),
    });
  }

  private async mutate(path: string, opts: RequestInit): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.apiFetch<VoiceProvidersResponse>(path, opts);
      this.data.set(res);
    } catch (err) {
      this.error.set(String(err));
      throw err;
    } finally {
      this.loading.set(false);
    }
  }
}
