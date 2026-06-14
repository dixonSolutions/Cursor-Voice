/**
 * Safe read/write helpers for `.env` provider secrets.
 *
 * Keys are never returned to the web app — only configured/complete status.
 * Updates are audited (without logging secret values).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reloadConfig } from '../config.js';
import {
  getProviderDefinition,
  type EnvKeyField,
  type ProviderId,
} from '../realtime/provider_keys.js';
import { isBedrockEnvViable } from '../realtime/bedrock/credentials.js';
import { childLogger } from '../log.js';
import { writeAudit } from './db.js';

const log = childLogger('envFile');

export interface EnvKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  /** Non-empty value present in .env or process.env. */
  configured: boolean;
  /** Meets minLength validation (or optional + empty). */
  complete: boolean;
}

/** Read raw .env file into a key→value map (does not merge process.env). */
function parseEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip inline comments (only when value is unquoted)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function validateKeyField(field: EnvKeyField, value: string | undefined): EnvKeyStatus {
  const configured = Boolean(value && value.length > 0);
  const complete =
    field.optional && !configured
      ? true
      : configured && (value?.length ?? 0) >= field.minLength;

  return {
    envVar: field.envVar,
    label: field.label,
    secret: field.secret,
    optional: Boolean(field.optional),
    configured,
    complete,
  };
}

/** Status of env keys for one provider (never includes values). */
export function getProviderKeyStatus(
  providerId: ProviderId,
  env: Record<string, string | undefined>,
): EnvKeyStatus[] {
  const def = getProviderDefinition(providerId);
  return def.envKeys.map((field) => validateKeyField(field, env[field.envVar]));
}

/** True when all required env keys for the provider are present and valid. */
export function isProviderViable(
  providerId: ProviderId,
  env: Record<string, string | undefined>,
): boolean {
  if (providerId === 'amazon_bedrock') {
    return isBedrockEnvViable(env);
  }
  return getProviderKeyStatus(providerId, env).every((s) => s.complete);
}

/**
 * Update one or more env vars for a provider in `.env`.
 * Merges with existing file; preserves unrelated lines and comments.
 */
export function updateProviderEnvKeys(
  providerId: ProviderId,
  updates: Record<string, string>,
): void {
  const def = getProviderDefinition(providerId);
  const allowed = new Set(def.envKeys.map((k) => k.envVar));

  for (const key of Object.keys(updates)) {
    if (!allowed.has(key)) {
      throw new Error(`Env var "${key}" is not valid for provider ${providerId}`);
    }
    const field = def.envKeys.find((f) => f.envVar === key)!;
    const value = updates[key]?.trim() ?? '';
    if (value.length > 0 && value.length < field.minLength) {
      throw new Error(`${key} is too short (min ${field.minLength} characters)`);
    }
  }

  const envPath = resolve(process.cwd(), '.env');
  const map = parseEnvFile(envPath);

  for (const [key, value] of Object.entries(updates)) {
    if (value.trim().length === 0) {
      map.delete(key);
      delete process.env[key];
    } else {
      map.set(key, value.trim());
      process.env[key] = value.trim();
    }
  }

  // Rebuild .env preserving structure where possible
  const lines: string[] = [];
  const written = new Set<string>();

  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of existing) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        lines.push(line);
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        lines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      if (map.has(key)) {
        lines.push(`${key}=${map.get(key)}`);
        written.add(key);
      } else if (allowed.has(key) && updates[key] !== undefined) {
        // Key removed intentionally — skip line
        written.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  // Append any new keys not in the file yet
  for (const [key, value] of map.entries()) {
    if (!written.has(key) && allowed.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  log.info({ providerId, keys: Object.keys(updates) }, 'provider env keys updated');
  writeAudit({
    tool: 'voice_provider_keys',
    result: 'ok',
    reason: `updated ${providerId}: ${Object.keys(updates).join(', ')}`,
  });

  reloadConfig();
}
