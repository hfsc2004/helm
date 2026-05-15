# Download

Model file downloader. HF Bearer auth, SHA-256 verification, multi-shard GGUF reassembly.

## Verbatim from PSF Core

The `.js` files in this directory are imported **verbatim** from PSF Core:

- `download-manager.js` — main entrypoint, queues, cancellation
- `download-manager-network.js` — HTTP/HTTPS + wget fallback path; HF auth
- `download-manager-fileops.js` — disk writes, temp/atomic moves
- `download-manager-split.js` — multi-shard `.gguf` reassembly via `llama-gguf-split`
- `download-manager-utils.js` — SHA-256, URL parsing, ETA formatters
- `download-manager-checksum.js` — post-download verification
- `huggingface-api.js` — HF REST API client
- `huggingface-api-network.js` — request plumbing
- `huggingface-api-utils.js` — repo/file/model metadata helpers
- `gguf-tools-builder.js` — fetches `llama-gguf-split` when needed

Plus one tiny in-tree shim:
- `logger.js` — 25-line stderr-only logger so the verbatim files have a `./logger` to require. Stderr-only is deliberate; NDJSON on stdout must stay clean.

**Do not modernize these files.** Resumable downloads were deliberately disabled by a Core-CE comment (see `download-manager-network.js` line ~68) because partial-resume caused UI progress jitter worse than re-downloading. Honor that decision.

## TypeScript surface

`index.ts` exposes typed `downloadModel`, `cancelDownload`, and `hf.*` for the rest of Helm. Customers never import the `.js` files directly.

## HF token

Tokens live in `<project root>/.env` as `HF_TOKEN=...`. The file is git-ignored and written with mode `0600`. See `core/secrets.ts`. The token is attached as `Authorization: Bearer <token>` only on outbound requests to `huggingface.co`.
