# Hardware

GPU and inference-target detection.

The `.js` files in this directory are imported **verbatim** from PSF Core. They are battle-tested across NVIDIA / Apple Silicon / Mali / VideoCore / Intel iGPU, and across multi-GPU systems with mixed display-active and headless cards (the headless-first preference is what lets a workstation with an M5000 driving the desktop and a P4 for inference pick the P4 automatically).

**Do not "modernize" these files.** If you find a real bug, fix it in place. The TypeScript surface in `index.ts` is thin glue, not a rewrite.

## Files

- `gpu-detector.js` — platform router
- `gpu-detector-common.js` — classification + nvidia-smi parsing (cross-platform)
- `gpu-detector-{linux-x64,linux-arm64,macos-arm,macos-intel,windows-x64,windows-arm64}.js` — per-platform probes (lspci, nvidia-smi, system_profiler, WMIC)
- `gpu-select.js` — headless-first NVIDIA selection (display-active GPUs lose ties)
- `index.ts` — TypeScript surface for the rest of Helm
