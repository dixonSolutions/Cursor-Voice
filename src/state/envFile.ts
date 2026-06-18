/**
 * Safe read/write helpers for `.env` AWS IAM keys.
 *
 * Keys are never returned to the web app — only configured/complete status.
 * Updates are audited (without logging secret values).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reloadConfig } from '../config.js';
import { isAwsEnvViable } from '../intelligence/aws/credentials.js';
import { childLogger } from '../log.js';
import { writeAudit } from './db.js';

const log = childLogger('envFile');

export interface EnvKeyField {
  envVar: string;
  label: string;
  minLength: number;
  secret: boolean;
  optional?: boolean;
}

export interface EnvKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  configured: boolean;
  complete: boolean;
}

export const AWS_ENV_KEYS: EnvKeyField[] = [
  { envVar: 'AWS_ACCESS_KEY_ID', label: 'IAM Access Key ID', minLength: 16, secret: false },
  { envVar: 'AWS_SECRET_ACCESS_KEY', label: 'IAM Secret Access Key', minLength: 20, secret: true },
  {
    envVar: 'AWS_BEARER_TOKEN_BEDROCK',
    label: 'Bedrock API Key (text only — not for Polly/Transcribe)',
    minLength: 40,
    secret: true,
    optional: true,
  },
  { envVar: 'AWS_REGION', label: 'Region', minLength: 5, secret: false, optional: true },
];

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
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
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

export function getAwsKeyStatus(env: Record<string, string | undefined>): EnvKeyStatus[] {
  return AWS_ENV_KEYS.map((field) => validateKeyField(field, env[field.envVar]));
}

export function isAwsConfigured(env: Record<string, string | undefined>): boolean {
  return isAwsEnvViable(env);
}

/**
 * Update AWS env vars in `.env`.
 * Merges with existing file; preserves unrelated lines and comments.
 */
export function updateAwsEnvKeys(updates: Record<string, string>): void {
  const allowed = new Set(AWS_ENV_KEYS.map((k) => k.envVar));

  for (const key of Object.keys(updates)) {
    if (!allowed.has(key)) {
      throw new Error(`Env var "${key}" is not a valid AWS key`);
    }
    const field = AWS_ENV_KEYS.find((f) => f.envVar === key)!;
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
        written.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  for (const [key, value] of map.entries()) {
    if (!written.has(key) && allowed.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  log.info({ keys: Object.keys(updates) }, 'AWS env keys updated');
  writeAudit({
    tool: 'aws_env_keys',
    result: 'ok',
    reason: `updated: ${Object.keys(updates).join(', ')}`,
  });

  reloadConfig();
}
