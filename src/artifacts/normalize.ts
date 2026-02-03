/**
 * Normalize a workspace or name string for uniqueness/lookup.
 *
 * Rules:
 * 1. Trim leading/trailing whitespace
 * 2. Lowercase
 * 3. Collapse internal whitespace to single spaces
 * 4. Preserve all other characters (underscores, hyphens, etc.)
 *
 * Examples:
 * - "  My Workspace  " → "my workspace"
 * - "AUTH_SYSTEM" → "auth_system"
 * - "Run-123-Explorer" → "run-123-explorer"
 */
export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
