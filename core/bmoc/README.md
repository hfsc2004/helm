# BMOC

Sole authority over process lifecycle in PSF Helm.

## Rule

Nothing in Helm spawns or kills its own child processes. Every subsystem that runs one — llama.cpp, whisper.cpp, piper, voice engines, future flight controllers, anything — **registers it through BMOC** and trusts BMOC to clean it up.

This is non-negotiable. The first time something bypasses BMOC, you start the next two-week orphan-process bug hunt.

## Companion rule (IPC subscriptions)

Long-lived IPC subscriptions (e.g., `state-stream`) are sessions too. They register with BMOC via `electron/ipc/subscriptions.ts → openSubscription(...)`, so window close and app shutdown reap them along with everything else. One-shot request/response IPC calls do **not** need session tracking — they open and close within the same call.

BMOC's role is **bookkeeping**, not transport. It does not route IPC; it tracks which sessions exist, who owns them, and how to close them. No session opens without BMOC knowing about it. That's how we keep a clean house.

## What's here

- `session-manager-process-utils.js` — verbatim. Cross-platform `isProcessRunning`, `killProcess`, `killProcessesOnPort`.
- `session-manager-state.js` — verbatim. Register / track / persist / validate sessions. Owns `sessions.json`.
- `session-manager-session-utils.js` — verbatim. ID generation, type normalization.
- `index.ts` — thin TypeScript surface that the rest of Helm imports.

## Origin

These three files are imported verbatim from PSF Core's `session-manager-*` modules. They survived years of edge-case fixes — process orphaning across crashes, port-reuse race conditions, signal handling differences across Linux/macOS/Windows. Do not "modernize" them. If you find a real bug, fix it in place, in the .js, and update the version stamp.

The service-specific siblings in PSF Core (Ollama, WebUI, AnythingLLM session launchers) were deliberately **not** copied. Helm's customers — voice install, llama.cpp manager, vehicle adapters — register through BMOC themselves.

## Usage

```ts
import * as bmoc from "@core/bmoc";

bmoc.initialize(appPath); // once at startup

const sessionId = bmoc.registerSession({
  type: "llama-cpp",
  pid: childProcess.pid,
  port: 52434,
});

// ...

await bmoc.closeSession(sessionId); // kills process, releases port, persists

// On app shutdown:
await bmoc.closeAllSessions();
```
