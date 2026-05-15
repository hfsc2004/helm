/**
 * Output discipline for the CLI.
 *
 * - stdout: JSON or NDJSON events only. Never log noise here.
 * - stderr: human-readable status messages, --pretty rendering, errors.
 *
 * Anything an agent might parse goes to stdout. Anything a human might read
 * but a machine should ignore goes to stderr.
 */

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

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
