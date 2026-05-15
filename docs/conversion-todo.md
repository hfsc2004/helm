# JS → TS Conversion TODO

**Audience:** agents (Claude Code, Codex CLI, Gemini CLI, future humans) working in this repo.

## Context

PSF Helm is a strict-TypeScript project. Two subsystems were imported **verbatim** from PSF Core as plain JavaScript because the code is battle-tested and rewriting it would re-introduce edge-case bugs that took years to find:

- `core/hardware/` — GPU detection, classification, headless-first NVIDIA selection
- `core/bmoc/` — process lifecycle authority (spawn, kill, port release, sessions.json)

Both subsystems sit behind a thin TypeScript wrapper (`index.ts`) that the rest of Helm imports from. The `.js` files themselves are not imported anywhere else — the architectural boundary is one typed door per subsystem.

`allowJs: true` is enabled in `tsconfig.json`, `electron/tsconfig.json`, and `cli/tsconfig.json` so the compiler can typecheck across the boundary.

## The plan

Convert files **one at a time, opportunistically.** Any time you're touching one of these files to fix a real bug or add a feature, *also* convert it to TypeScript in the same PR. Two birds, one stone. Within a few months everything is `.ts` and the verbatim policy gracefully sunsets.

**Do not do a big-bang conversion.** Per-file, per-PR, in the natural course of work.

## Why not all at once?

The bugs strict TS will catch are the *latent* bugs already in the `.js` — unchecked null paths, return shapes that drift between code paths, fields used before assignment. Some are real. Some are "this can never happen, but the compiler doesn't know that" and need `as` or `// @ts-expect-error`. It's detective work, not typing. Worth doing carefully, not in one rushed pass.

## Conversion checklist (per file)

1. Rename `.js` → `.ts`
2. Convert `require(...)` → `import ... from "..."` and `module.exports` → `export`
3. Add explicit types — function parameters, return types, object shapes. Promote JSDoc inferences the compiler already half-knows.
4. Run `npm run check` and fix everything strict mode flags:
   - Real bugs: fix the code
   - False positives: narrow with explicit checks, or use `// @ts-expect-error <reason>` (never `any` without a reason)
5. Update the wrapper's `as` cast in `core/<subsystem>/index.ts` — replace it with a direct typed import
6. Verify the CLI command that exercises this code still works end-to-end (`helm hardware`, etc.)
7. Commit. One file per commit ideally.

## Order

### `core/hardware/`

Recommended order — smallest and most-shared first:

| # | File | Lines | Notes |
|---|---|---|---|
| 1 | `gpu-select.js` | 82 | Smallest, self-contained, only depends on `child_process` |
| 2 | `gpu-detector.js` | 43 | Trivial platform router |
| 3 | `gpu-detector-common.js` | 439 | Shared classifier + nvidia-smi parsing. Converting this unlocks better types for the platform files. |
| 4 | `gpu-detector-macos-intel.js` | 152 | Smallest platform file |
| 5 | `gpu-detector-macos-arm.js` | 164 | |
| 6 | `gpu-detector-windows-x64.js` | 220 | |
| 7 | `gpu-detector-linux-x64.js` | 251 | |
| 8 | `gpu-detector-windows-arm64.js` | 264 | |
| 9 | `gpu-detector-linux-arm64.js` | 479 | Largest; do last |

### `core/bmoc/`

Recommended order — utilities first, state last:

| # | File | Lines | Notes |
|---|---|---|---|
| 1 | `session-manager-session-utils.js` | 133 | Pure functions, no side effects |
| 2 | `session-manager-process-utils.js` | 159 | Wraps `child_process`; cross-platform kill logic |
| 3 | `session-manager-state.js` | 265 | Stateful manager. Convert last so the dep types are already real. |

## Rules

- **Do not "modernize" behavior during conversion.** Types only. If you find a real bug, fix it in a separate commit with a clear message. Don't smuggle behavior changes into a "type cleanup" PR.
- **Do not delete the .js's `console.log` calls.** The wrapper in `core/hardware/index.ts` redirects them to stderr so they stay diagnostic without polluting NDJSON. The conversion can switch them to a real logger eventually, but only after the rest of Helm has a logger to switch *to*.
- **Run `npm run helm -- hardware` after every hardware conversion.** That's the integration test. The output must remain identical and the `nvidiaSelection.index` must still pick headless cards over display-active ones on multi-GPU systems.
- **Run a registered/closed session round-trip after every BMOC conversion** once that surface gets a CLI command. (Doesn't exist yet — file a follow-up.)

## Status (as of 2026-05-15)

All files unconverted. None blocking. The verbatim policy is in effect.

When a file is converted, update the table above:
- Strike through the row
- Add the commit SHA
- If the conversion surfaced a real bug, link the fix commit too

## Why this doc exists for agents specifically

Agents working in this repo will see plain `.js` files in two TypeScript subsystems and may be tempted to "fix the inconsistency" by converting them all in one pass. **Do not do this without a reason in the current task.** The verbatim-then-opportunistic-conversion strategy is deliberate.

If a user asks you to convert these files, point them at this document, ask which one(s), and follow the checklist above per file.
