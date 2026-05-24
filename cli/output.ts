// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Output discipline for the CLI.
 *
 * - stdout: JSON or NDJSON events only. Never log noise here.
 * - stderr: human-readable status messages, --pretty rendering, errors.
 *
 * Anything an agent might parse goes to stdout. Anything a human might read
 * but a machine should ignore goes to stderr.
 */

/**
 * Anything JSON-serializable. We don't recurse the type structurally because
 * TypeScript's strict mode refuses to assign concrete typed objects to the
 * recursive form even when they are valid JSON. JSON.stringify enforces the
 * actual constraint at runtime.
 */
export type Json = unknown;

export function emit(value: Json): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function log(message: string): void {
  process.stderr.write(message + "\n");
}

export function fatal(message: string, exitCode: number): never {
  process.stderr.write(message + "\n");
  process.exit(exitCode);
}
