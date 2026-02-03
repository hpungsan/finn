import type {
  Artifact,
  StoreOpts,
  FetchOpts,
  ListOpts,
  ListResult,
  ComposeOpts,
  ComposeResult,
  DeleteOpts,
} from "./types.js";

/**
 * Interface for artifact storage operations.
 * Implementations: SqliteArtifactStore (production), InMemoryArtifactStore (tests)
 */
export interface ArtifactStore {
  /**
   * Store a new artifact or update an existing one.
   * - expected_version: update with optimistic locking
   * - mode: "error" (default) or "replace" for create/overwrite behavior
   */
  store(opts: StoreOpts): Promise<Artifact>;

  /**
   * Fetch a single artifact by id or workspace+name.
   * Returns null if not found.
   */
  fetch(opts: FetchOpts): Promise<Artifact | null>;

  /**
   * List artifacts with optional filters.
   * Returns data (not text) for efficiency.
   */
  list(opts: ListOpts): Promise<ListResult>;

  /**
   * Compose multiple artifacts into a bundle.
   * - markdown: bundles text views, requires text on all artifacts
   * - json: returns data only
   */
  compose(opts: ComposeOpts): Promise<ComposeResult>;

  /**
   * Soft-delete an artifact by id or workspace+name.
   */
  delete(opts: DeleteOpts): Promise<void>;
}
