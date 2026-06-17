/**
 * OS-aware paths for Cursor global MCP and cursor-voice user files.
 *
 * Cursor loads global MCP servers from ~/.cursor/mcp.json (all platforms).
 * User-scoped cursor-voice metadata prefers ~/Projects when that folder exists.
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type CursorHostOs = 'windows' | 'macos' | 'linux' | 'unknown';

export function detectCursorHostOs(): CursorHostOs {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

/** User home directory (Windows: %USERPROFILE%, macOS/Linux: $HOME). */
export function resolveUserHome(): string {
  return homedir();
}

/**
 * Preferred root for cursor-voice user files on this machine.
 * Uses ~/Projects when present, otherwise the user home directory.
 */
export function resolveCursorVoiceUserRoot(): string {
  const home = resolveUserHome();
  const projectsDir = join(home, 'Projects');
  if (existsSync(projectsDir)) return projectsDir;
  return home;
}

/** Cursor IDE global MCP config path (~/.cursor/mcp.json). */
export function resolveGlobalMcpJsonPath(): string {
  return join(resolveUserHome(), '.cursor', 'mcp.json');
}

/** Optional directory for cursor-voice global metadata beside user projects. */
export function resolveCursorVoiceMetaDir(): string {
  return join(resolveCursorVoiceUserRoot(), '.cursor-voice');
}

/** Human-readable path label for logs (tilde when under home). */
export function formatPathForLog(absolutePath: string): string {
  const home = resolveUserHome();
  if (absolutePath === home) return '~';
  if (absolutePath.startsWith(`${home}/`) || absolutePath.startsWith(`${home}\\`)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}
