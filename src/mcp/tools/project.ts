/**
 * Project tools — cursor_list_projects, cursor_set_project
 *
 * Own-bridge tools backed by the project registry (not the cursor-agent CLI).
 * These are the voice model's window into which codebases exist.
 *
 * Security: paths are NEVER returned. Only name + description + aliases.
 */

import {
  listProjects,
  resolveProject,
  setActiveProject,
  type Project,
} from '../../state/registry.js';

// ── cursor_list_projects ──────────────────────────────────────────────────

export interface ListProjectsArgs {
  query?: string;
}

export interface ProjectSummary {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  active: boolean;
}

export interface ListProjectsResult {
  projects: ProjectSummary[];
}

/**
 * List all enabled projects from the registry.
 * Optional `query` filters by name, alias, or description (case-insensitive).
 * Marks the session's active project with `active: true`.
 */
export function handleListProjects(
  args: ListProjectsArgs,
  activeProject: string | null,
): ListProjectsResult {
  let projects = listProjects();

  if (args.query) {
    const q = args.query.toLowerCase();
    projects = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        p.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }

  return {
    projects: projects.map((p) => ({
      name: p.name,
      description: p.description,
      aliases: p.aliases,
      enabled: p.enabled,
      active: p.name === activeProject,
    })),
  };
}

// ── cursor_set_project ────────────────────────────────────────────────────

export interface SetProjectArgs {
  project: string;
}

export interface SetProjectResult {
  active_project: string;
  description: string | null;
  // path_hash omitted — we don't expose even hashes of paths
  aliases: string[];
}

/**
 * Set the sticky active project for a session.
 * Resolves the name/alias via the registry and rejects unknown/disabled projects.
 * Returns the canonical name and description so the model can read it back.
 *
 * Throws with a structured error if the project cannot be resolved.
 */
export function handleSetProject(
  args: SetProjectArgs,
  sessionKey: string,
): SetProjectResult {
  const resolved = resolveProject(args.project);

  if (!resolved) {
    const available = listProjects().map((p) => `"${p.name}"`).join(', ');
    throw new Error(
      `Project "${args.project}" not found. Available: ${available || 'none registered'}.`,
    );
  }

  setActiveProject(sessionKey, resolved.name);

  return {
    active_project: resolved.name,
    description: resolved.description,
    aliases: resolved.aliases,
  };
}

// ── Shared helper: resolve project or throw ───────────────────────────────

/**
 * Resolve project for any tool call that accepts an optional `project` arg.
 * Falls back to the session's active project if `projectArg` is omitted.
 * Throws a user-facing error if no project can be determined.
 */
export function resolveProjectOrThrow(
  projectArg: string | undefined,
  activeProject: string | null,
): Project {
  const input = projectArg ?? activeProject ?? null;

  if (!input) {
    throw new Error(
      'No active project set. Use cursor_set_project first, or specify `project` in this call.',
    );
  }

  const resolved = resolveProject(input);
  if (!resolved) {
    const available = listProjects().map((p) => `"${p.name}"`).join(', ');
    throw new Error(
      `Project "${input}" not found or disabled. Available: ${available || 'none registered'}.`,
    );
  }

  return resolved;
}
