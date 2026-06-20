/**
 * Read/write config.json (non-secret operational settings).
 *
 * Reads use the in-memory cache populated at startup / reload — no disk I/O.
 * Writes validate once, persist to disk, and refresh the cache without re-reading.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConfigFileSchema,
  cloneConfigFile,
  getConfigPath,
  reloadConfig,
  type ConfigFile,
} from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('configFile');

/** Return a mutable clone of config.json (for PATCH flows that edit then write). */
export function readConfigFile(): ConfigFile {
  return cloneConfigFile();
}

/** Persist config.json and refresh the in-memory singleton (no disk re-read). */
export function writeConfigFile(config: ConfigFile): void {
  const result = ConfigFileSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid config.json:\n${result.error.message}`);
  }

  const configPath = resolve(getConfigPath());
  writeFileSync(configPath, JSON.stringify(result.data, null, 2) + '\n', { mode: 0o644 });
  log.debug({ configPath }, 'config.json written');
  reloadConfig(result.data);
}
