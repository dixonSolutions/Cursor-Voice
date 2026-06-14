/**
 * Read/write config.json (non-secret operational settings).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigFileSchema, type ConfigFile, getConfigPath } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('configFile');

/** Read and validate config.json from disk (bypasses singleton cache). */
export function readConfigFile(): ConfigFile {
  const configPath = resolve(getConfigPath());
  if (!existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config.json:\n${result.error.message}`);
  }
  return result.data;
}

/** Persist config.json to disk (pretty-printed). */
export function writeConfigFile(config: ConfigFile): void {
  const configPath = resolve(getConfigPath());
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
  log.debug({ configPath }, 'config.json written');
}
