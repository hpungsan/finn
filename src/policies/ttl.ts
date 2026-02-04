import {
  ArtifactError,
  type ArtifactStore,
  type StoreOpts,
} from "../artifacts/index.js";

/** TTL constants in seconds */
export const TTL = {
  EPHEMERAL: 3600, // 1 hour - explorer findings
  SESSION: 7200, // 2 hours - verifier outputs, design specs
  RUN_SUCCESS: 7 * 24 * 3600, // 7 days
  RUN_FAILURE: 30 * 24 * 3600, // 30 days
  PERSISTENT: null, // no expiry - DLQ entries
} as const;

/** Workspace → default TTL mapping */
export const WORKSPACE_TTL: Record<string, number | null> = {
  plan: TTL.EPHEMERAL,
  feat: TTL.SESSION,
  fix: TTL.SESSION,
  runs: null, // per-artifact (success vs failure)
  dlq: TTL.PERSISTENT,
  default: null,
};

/** Size limits per artifact kind (chars) */
export const KIND_SIZE_LIMITS: Record<string, number> = {
  "run-record": 200_000, // grows unboundedly
  default: 50_000, // bounded per-step output
};

export type StoreArtifactOpts = StoreOpts & {
  workspace?: string;
};

/** Kinds that require numeric ttl_seconds (never permanent) */
const REQUIRES_NUMERIC_TTL = ["run-record", "step-result"];

/**
 * Store artifact with TTL policy applied.
 * - Requires numeric ttl_seconds for run-record/step-result (use getRunRecordTtl())
 * - Uses workspace default TTL if ttl_seconds not provided (undefined)
 * - Passes through null (explicit no expiry) for other kinds
 * - Validates kind-specific size limits
 */
export async function storeArtifact(
  store: ArtifactStore,
  opts: StoreArtifactOpts,
) {
  // Require positive finite TTL for run durability artifacts (never permanent)
  if (REQUIRES_NUMERIC_TTL.includes(opts.kind)) {
    if (
      typeof opts.ttl_seconds !== "number" ||
      !Number.isFinite(opts.ttl_seconds) ||
      opts.ttl_seconds <= 0
    ) {
      throw new ArtifactError(
        "INVALID_REQUEST",
        `${opts.kind} requires positive finite ttl_seconds (use getRunRecordTtl())`,
      );
    }
  }

  // Validate kind-specific size limits
  const dataJson = JSON.stringify(opts.data);
  const limit = KIND_SIZE_LIMITS[opts.kind] ?? KIND_SIZE_LIMITS.default;
  if (dataJson.length > limit) {
    throw new ArtifactError(
      "DATA_TOO_LARGE",
      `${opts.kind} data exceeds ${limit} chars (got ${dataJson.length})`,
    );
  }

  const workspace = opts.workspace ?? "default";

  // Important: distinguish undefined (use default) from null (explicit no expiry)
  const ttl =
    opts.ttl_seconds !== undefined
      ? opts.ttl_seconds // number or null - use as-is
      : (WORKSPACE_TTL[workspace] ?? WORKSPACE_TTL.default);

  return store.store({
    ...opts,
    ttl_seconds: ttl,
  });
}

/**
 * Get TTL for run record based on status.
 */
export function getRunRecordTtl(status: "OK" | "BLOCKED" | "FAILED"): number {
  return status === "OK" ? TTL.RUN_SUCCESS : TTL.RUN_FAILURE;
}
