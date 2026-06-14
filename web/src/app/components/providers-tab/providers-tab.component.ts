import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AccordionModule } from 'primeng/accordion';
import { Button } from 'primeng/button';
import { Divider } from 'primeng/divider';
import { Fieldset } from 'primeng/fieldset';
import { Fluid } from 'primeng/fluid';
import { IftaLabel } from 'primeng/iftalabel';
import { InputGroup } from 'primeng/inputgroup';
import { InputGroupAddon } from 'primeng/inputgroupaddon';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { Panel } from 'primeng/panel';
import { Password } from 'primeng/password';
import { Select } from 'primeng/select';
import { Skeleton } from 'primeng/skeleton';
import { Tag } from 'primeng/tag';
import { Toolbar } from 'primeng/toolbar';

import type { ProviderId, ProviderView } from '../../models/voice-providers';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { ToastService } from '../../services/toast.service';

interface ProviderOption {
  label: string;
  value: ProviderId;
}

@Component({
  selector: 'cv-providers-tab',
  standalone: true,
  imports: [
    FormsModule,
    AccordionModule,
    Button,
    Divider,
    Fieldset,
    Fluid,
    IftaLabel,
    InputGroup,
    InputGroupAddon,
    InputText,
    Message,
    Panel,
    Password,
    Select,
    Skeleton,
    Tag,
    Toolbar,
  ],
  templateUrl: './providers-tab.component.html',
})
export class ProvidersTabComponent implements OnInit {
  protected readonly voiceProviders = inject(VoiceProvidersService);
  private readonly toast = inject(ToastService);

  protected keyInputs: Record<string, string> = {};
  protected newModelId = '';
  protected newModelLabel = '';
  protected addModelProviderId: ProviderId | null = null;
  protected registerSelection: ProviderId | null = null;

  protected readonly defaultProviderOptions = signal<ProviderOption[]>([]);

  ngOnInit(): void {
    void this.voiceProviders.refresh().then(() => this.syncDefaultOptions());
  }

  protected syncDefaultOptions(): void {
    const data = this.voiceProviders.data();
    if (!data) return;
    this.defaultProviderOptions.set(
      data.providers
        .filter((p) => p.registered && p.viable)
        .map((p) => ({ label: p.displayName, value: p.id })),
    );
  }

  protected async onRegister(): Promise<void> {
    if (!this.registerSelection) return;
    try {
      await this.voiceProviders.register(this.registerSelection);
      this.registerSelection = null;
      this.syncDefaultOptions();
      this.toast.success('Provider registered');
    } catch {
      this.toast.error('Could not register provider');
    }
  }

  protected async onUnregister(id: ProviderId): Promise<void> {
    if (!confirm(`Remove ${id} from registered providers?`)) return;
    await this.voiceProviders.unregister(id);
    this.syncDefaultOptions();
  }

  protected async onSetDefault(id: ProviderId): Promise<void> {
    try {
      await this.voiceProviders.setDefaultProvider(id);
      this.syncDefaultOptions();
      this.toast.success('Default provider updated');
    } catch {
      this.toast.error('Could not set default provider');
    }
  }

  protected async onSetDefaultModel(providerId: ProviderId, modelId: string): Promise<void> {
    try {
      await this.voiceProviders.setDefaultModel(providerId, modelId);
      this.toast.success('Default model updated');
    } catch {
      this.toast.error('Could not set default model');
    }
  }

  protected openAddModel(providerId: ProviderId): void {
    this.addModelProviderId = providerId;
    this.newModelId = '';
    this.newModelLabel = '';
  }

  protected async onAddModel(): Promise<void> {
    if (!this.addModelProviderId || !this.newModelId.trim()) return;
    await this.voiceProviders.addModel(
      this.addModelProviderId,
      this.newModelId.trim(),
      this.newModelLabel.trim() || undefined,
    );
    this.addModelProviderId = null;
  }

  protected async onRemoveModel(providerId: ProviderId, modelId: string): Promise<void> {
    if (!confirm(`Remove model "${modelId}"?`)) return;
    await this.voiceProviders.removeModel(providerId, modelId);
  }

  protected async onSaveKeys(provider: ProviderView): Promise<void> {
    const keys: Record<string, string> = {};
    for (const field of provider.keyStatus) {
      const val = this.keyInputs[field.envVar]?.trim();
      if (val) keys[field.envVar] = val;
    }
    if (Object.keys(keys).length === 0) return;
    await this.voiceProviders.updateKeys(provider.id, keys);
    for (const k of Object.keys(keys)) {
      delete this.keyInputs[k];
    }
    this.syncDefaultOptions();
  }

  protected addKnownModel(providerId: ProviderId, modelId: string, label: string): void {
    void this.voiceProviders.addModel(providerId, modelId, label);
  }

  protected registerOptions(): ProviderOption[] {
    const data = this.voiceProviders.data();
    if (!data) return [];
    return data.availableToRegister.map((id) => {
      const cat = data.catalog.find((c) => c.id === id);
      return { label: cat?.displayName ?? id, value: id };
    });
  }

  protected catalogKnownNotAdded(provider: ProviderView): Array<{ id: string; label: string }> {
    const data = this.voiceProviders.data();
    if (!data || !provider.registered) return [];
    const cat = data.catalog.find((c) => c.id === provider.id);
    if (!cat) return [];
    const existing = new Set(provider.models.map((m) => m.id));
    return cat.knownModels.filter((m) => !existing.has(m.id));
  }
}
