/**
 * Core artifact type representing durable state for workflow orchestration.
 * Code operates on `data`, LLMs consume `text` via compose.
 */
export interface Artifact<T = unknown> {
  // Identity
  id: string; // ULID, auto-generated
  workspace: string; // namespace as provided (default: "default")
  workspace_norm: string; // normalized for uniqueness/lookup
  name?: string; // unique handle as provided
  name_norm?: string; // normalized for uniqueness/lookup

  // Content
  kind: string; // artifact type (e.g., "run-record", "explorer-finding")
  data: T; // structured JSON (validated by caller)
  text?: string; // rendered view for LLMs (provided by caller)

  // Orchestration
  run_id?: string; // groups artifacts for one workflow run
  phase?: string; // workflow stage
  role?: string; // agent role
  tags?: string[]; // categorization
  schema_version?: string; // content schema version (e.g., "explorer-finding@1")

  // Lifecycle
  version: number; // optimistic concurrency (starts at 1)
  ttl_seconds?: number; // time-to-live (undefined = no expiry)
  expires_at?: number; // computed at write time: now_ms + (ttl_seconds * 1000)
  created_at: number; // Unix timestamp (ms)
  updated_at: number; // Unix timestamp (ms)
  deleted_at?: number; // soft delete timestamp (ms)
}

/**
 * Options for storing an artifact.
 * - expected_version: enables optimistic locking (update flow)
 * - mode: "error" (default) fails on name collision, "replace" overwrites
 */
export type StoreOpts = {
  workspace?: string; // default: "default"
  name?: string; // unique handle (optional)
  kind: string; // required
  data: unknown; // required (caller validates before calling)
  text?: string; // optional rendered view
  run_id?: string;
  phase?: string;
  role?: string;
  tags?: string[];
  schema_version?: string;
  ttl_seconds?: number | null; // null = no expiry
  expected_version?: number; // optimistic locking
  mode?: "error" | "replace"; // default: "error"
};

/**
 * Options for fetching a single artifact.
 * Address by id OR (workspace + name) - not both.
 */
export type FetchOpts = {
  id?: string; // by ID
  workspace?: string; // by name (requires workspace)
  name?: string;
  include_expired?: boolean;
  include_deleted?: boolean;
};

/**
 * Options for listing artifacts.
 */
export type ListOpts = {
  workspace?: string;
  kind?: string;
  run_id?: string;
  phase?: string;
  role?: string;
  include_expired?: boolean;
  include_deleted?: boolean;
  order_by?: "created_at" | "updated_at"; // default: "updated_at", always with id tie-breaker
  limit?: number; // default: 50, max: 100
  offset?: number;
};

/**
 * Result from list operation.
 * items includes data but excludes text for efficiency.
 */
export type ListResult = {
  items: Omit<Artifact, "text">[]; // data only, no text
  pagination: {
    limit: number;
    offset: number;
    has_more: boolean;
  };
};

/**
 * Reference to an artifact for compose operation.
 * Address by id OR (workspace + name) - not both.
 */
export type ArtifactRef = {
  id?: string;
  workspace?: string;
  name?: string;
};

/**
 * Options for composing multiple artifacts into a bundle.
 */
export type ComposeOpts = {
  items: ArtifactRef[];
  format?: "markdown" | "json"; // default: "markdown"
};

/**
 * Result from compose operation.
 * - markdown: requires text, returns bundle_text
 * - json: returns data only in parts array
 */
export type ComposeResult =
  | { format: "markdown"; bundle_text: string }
  | {
      format: "json";
      parts: Array<{ id: string; name?: string; data: unknown }>;
    };

/**
 * Options for deleting an artifact.
 * Address by id OR (workspace + name) - not both.
 */
export type DeleteOpts = {
  id?: string;
  workspace?: string;
  name?: string;
};
