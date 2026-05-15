# Storage

The single owner of all disk I/O in PSF Helm.

Nothing else writes to disk. Every persistent write goes through here, declares its category, and respects the cap defined in `limits.ts`. If a new category is needed, add it to both this module and to `limits.ts` — no ad-hoc files.

This is the only way storage caps actually hold over time.
