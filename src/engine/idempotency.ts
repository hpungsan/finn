import { createHash } from "node:crypto";
import type { ArtifactInputRef, StepInputs, StepVersioning } from "./types.js";

/** SHA-256 hash as hex string (64 characters) */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Normalize file paths for cross-platform consistency.
 * - Backslashes → forward slashes
 * - Remove trailing slash (except root `/`)
 *
 * Note: Does NOT resolve `.` or `..` segments — paths should already be
 * absolute/canonical before reaching this function.
 */
export function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized;
}

/**
 * Deterministic JSON serialization with sorted keys (recursive).
 *
 * Rules:
 * - Primitive values: delegate to JSON.stringify
 * - Arrays: preserve order, recurse into elements; undefined → null
 * - Objects: sort keys alphabetically, recurse into values
 * - Omit keys with `undefined` values (matches JSON.stringify behavior)
 * - Circular references: unsupported (will stack overflow — inputs are controlled types)
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Prepare inputs for hashing.
 * - Validate `artifact_refs` have name or id
 * - Sort `artifact_refs` by `(workspace, name ?? id)`
 * - Normalize and sort `file_paths`
 * - Omit empty arrays and objects with no keys
 * - Omit keys with `undefined` values
 * - Return new object (no mutation)
 *
 * @throws Error if any artifact_ref has neither name nor id
 */
export function canonicalizeInputs(inputs: StepInputs): StepInputs {
  const result: StepInputs = {};

  if (inputs.repo_hash !== undefined) {
    result.repo_hash = inputs.repo_hash;
  }

  if (inputs.artifact_refs && inputs.artifact_refs.length > 0) {
    for (const ref of inputs.artifact_refs) {
      if (!ref.name && !ref.id) {
        throw new Error("ArtifactInputRef requires name or id");
      }
    }
    result.artifact_refs = [...inputs.artifact_refs].sort(
      (a: ArtifactInputRef, b: ArtifactInputRef) => {
        const wsCompare = a.workspace.localeCompare(b.workspace);
        if (wsCompare !== 0) return wsCompare;
        const aKey = a.name ?? a.id ?? "";
        const bKey = b.name ?? b.id ?? "";
        return aKey.localeCompare(bKey);
      },
    );
  }

  if (inputs.file_paths && inputs.file_paths.length > 0) {
    result.file_paths = inputs.file_paths.map(normalizePath).sort();
  }

  if (inputs.params && Object.keys(inputs.params).length > 0) {
    result.params = inputs.params;
  }

  return result;
}

export function computeInputsDigest(inputs: StepInputs): string {
  const canonical = canonicalizeInputs(inputs);
  const serialized = stableStringify(canonical);
  return sha256Hex(serialized); // 64 hex chars
}

export function computeStepInstanceId(
  step_id: string,
  inputs_digest: string,
  versioning: StepVersioning,
): string {
  const parts = [
    step_id,
    inputs_digest,
    versioning.model,
    versioning.schema_version,
    versioning.prompt_version,
  ];
  return sha256Hex(parts.join("\0")); // 64 hex chars, null separator
}

/**
 * Convenience function combining both digest and instance ID computation.
 */
export function computeStepIdempotency(
  step_id: string,
  inputs: StepInputs,
  versioning: StepVersioning,
): { inputs_digest: string; step_instance_id: string } {
  const inputs_digest = computeInputsDigest(inputs);
  const step_instance_id = computeStepInstanceId(
    step_id,
    inputs_digest,
    versioning,
  );
  return { inputs_digest, step_instance_id };
}
