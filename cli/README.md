# CLI (`helm`)

The agent-first command-line surface for PSF Helm. Subcommands are designed for frontier models and scripts, not primarily for humans.

## Design rules

- Output is JSON by default. `--pretty` produces human-readable output.
- Streaming commands emit NDJSON (newline-delimited JSON) on stdout.
- Logs go to stderr; stdout stays clean for event streams.
- Every command supports `--timeout <ms>`, `--trace-id <id>`, `--dry-run` where mutating.
- Exit codes are distinct (0 success, 1 command failure, 2 transport failure, 3 safety abort, 64 usage error).
- `helm describe` emits the full command schema as JSON so agents can introspect without parsing help text.

## Layout

- `helm.ts` — entry point, argument parser, command dispatcher
- `commands/` — one file per subcommand; each registers a `CommandDef` and an execute function
- `output.ts` — JSON / NDJSON / pretty output helpers; stdout discipline
