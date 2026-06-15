/**
 * Run mode — test (local dev) vs serve (production / Tailscale).
 *
 * Ports and URLs are defined in config.json under settings.runModes.
 * See docs/07-data-and-deployment.md → Run mode.
 */

import type { RunMode, Settings } from './config.js';

export interface RunModeInfo {
  runMode: RunMode;
  backendPort: number;
  webPort: number;
  /** Local bind URL for the bridge (always 127.0.0.1). */
  backendUrl: string;
  /** URL the user opens in the browser. */
  webUrl: string;
  /** Tailscale / public HTTPS origin (serve mode only, when set). */
  publicBaseUrl?: string;
  /** In test mode Angular runs on webPort; the unified entry URL is backendPort. */
  useDevWebServer: boolean;
}

/** Resolve ports and URLs for the active runMode from settings. */
export function getRunModeInfo(settings: Settings): RunModeInfo {
  const mode = settings.runMode;
  const row = settings.runModes[mode];

  if (mode === 'test') {
    const test = settings.runModes.test;
    return {
      runMode: 'test',
      backendPort: test.backendPort,
      webPort: test.webPort,
      backendUrl: `http://127.0.0.1:${test.backendPort}`,
      webUrl: `http://localhost:${test.backendPort}`,
      useDevWebServer: true,
    };
  }

  const serve = settings.runModes.serve;
  const backendUrl = `http://127.0.0.1:${serve.backendPort}`;
  const publicBaseUrl = serve.publicBaseUrl;

  return {
    runMode: 'serve',
    backendPort: serve.backendPort,
    webPort: serve.backendPort,
    backendUrl,
    webUrl: publicBaseUrl ?? backendUrl,
    publicBaseUrl,
    useDevWebServer: false,
  };
}
