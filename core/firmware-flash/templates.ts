import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sketch template loader.
 *
 * Templates live in <repo>/firmware/templates/<id>/. Each has:
 *   - template.json    metadata: target, fqbn, vars[]
 *   - sketch.ino       source with {{key}} placeholders
 *
 * Lookup is by template id (the directory name and template.json `id` must match).
 */

export type VarType = "string" | "secret" | "number" | "boolean";

/**
 * "static"    — directory contains sketch.ino with {{placeholders}}.
 * "generator" — directory contains builder.js (or builder.ts, in source mode)
 *               that exports `build(vars) → string`. Used when a sketch is too
 *               structural for placeholder substitution (e.g. ESP32-S3 camera
 *               with conditional pin profiles).
 */
export type TemplateKind = "static" | "generator";

export interface TemplateVar {
  key: string;
  type: VarType;
  required?: boolean;
  default?: string | number | boolean;
  label?: string;
}

export interface TemplateManifest {
  id: string;
  name: string;
  description?: string;
  kind?: TemplateKind;
  target: string;
  fqbn: string;
  core: string;
  vehicleKind?: string;
  capabilities?: string[];
  vars: TemplateVar[];
}

export interface LoadedTemplate {
  manifest: TemplateManifest;
  /** Absolute path to the template directory. */
  dir: string;
  /** Raw sketch source with {{placeholders}}. Empty for generator templates. */
  sketchSource: string;
}

function templatesRoot(): string {
  // CommonJS context: walk up from __dirname looking for firmware/templates.
  // Works in both tsx (source path) and compiled (dist-electron path).
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, "firmware", "templates");
    if (existsSync(candidate)) return candidate;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // Last resort: assume cwd is the repo.
  return join(process.cwd(), "firmware", "templates");
}

export function listTemplates(): TemplateManifest[] {
  const root = templatesRoot();
  if (!existsSync(root)) return [];
  const out: TemplateManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "template.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(manifestPath, "utf8")
      ) as TemplateManifest;
      if (parsed.id && parsed.fqbn && parsed.target) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function loadTemplate(id: string): LoadedTemplate | null {
  const root = templatesRoot();
  const dir = join(root, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const manifestPath = join(dir, "template.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TemplateManifest;
  const kind: TemplateKind = manifest.kind ?? "static";

  if (kind === "static") {
    const sketchPath = join(dir, "sketch.ino");
    if (!existsSync(sketchPath)) return null;
    const sketchSource = readFileSync(sketchPath, "utf8");
    return { manifest, dir, sketchSource };
  }

  // Generator templates load their sketch source lazily via renderSketch().
  // Sanity-check that the builder file exists at template load so a missing
  // builder fails fast rather than mid-flash. The .js form is what the build
  // step emits; in tsx (dev) mode the loader resolves .js to .ts.
  const builderJs = join(dir, "builder.js");
  if (!existsSync(builderJs)) return null;
  return { manifest, dir, sketchSource: "" };
}
