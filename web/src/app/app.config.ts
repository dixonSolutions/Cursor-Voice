import type { ApplicationConfig } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Custom preset: Aura Dark with indigo-500 as primary and slate surfaces.
 * Matches the existing design token palette (docs/06 UX guidance).
 */
const CursorVoicePreset = definePreset(Aura, {
  semantic: {
    primary: {
      50:  '{indigo.50}',
      100: '{indigo.100}',
      200: '{indigo.200}',
      300: '{indigo.300}',
      400: '{indigo.400}',
      500: '{indigo.500}',
      600: '{indigo.600}',
      700: '{indigo.700}',
      800: '{indigo.800}',
      900: '{indigo.900}',
      950: '{indigo.950}',
    },
    colorScheme: {
      dark: {
        primary: {
          color:        '{indigo.500}',
          contrastColor: '#ffffff',
          hoverColor:   '{indigo.400}',
          activeColor:  '{indigo.600}',
        },
        surface: {
          0:   '#ffffff',
          50:  '{slate.50}',
          100: '{slate.100}',
          200: '{slate.200}',
          300: '{slate.300}',
          400: '{slate.400}',
          500: '{slate.500}',
          600: '{slate.600}',
          700: '{slate.700}',
          800: '{slate.800}',
          900: '{slate.900}',
          950: '{slate.950}',
        },
      },
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimationsAsync(),
    MessageService,
    providePrimeNG({
      theme: {
        preset: CursorVoicePreset,
        options: {
          // .p-dark applied to <html> in index.html — always dark
          darkModeSelector: '.p-dark',
          cssLayer: false,
        },
      },
      ripple: true,
    }),
  ],
};
