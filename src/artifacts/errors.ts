/**
 * Error codes for artifact store operations.
 */
export type ErrorCode =
  | "VERSION_MISMATCH"       // expected_version doesn't match current
  | "NAME_ALREADY_EXISTS"    // mode: "error" and name exists
  | "NOT_FOUND"              // artifact doesn't exist
  | "INVALID_REQUEST"        // invalid parameter combination
  | "AMBIGUOUS_ADDRESSING"   // both id AND workspace+name provided
  | "DATA_TOO_LARGE"         // data exceeds 200K chars
  | "TEXT_TOO_LARGE"         // text exceeds 12K chars
  | "COMPOSE_MISSING_TEXT";  // artifact in items has no text (markdown format)

/**
 * Custom error class for artifact store operations.
 * Enables typed error handling via error.code.
 */
export class ArtifactError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}
