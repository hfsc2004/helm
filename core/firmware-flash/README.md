# Firmware flash

Compile + upload sketches to microcontrollers using Helm's private arduino-cli.

## What's here

- `templates.ts` — load sketch templates from `<repo>/firmware/templates/<id>/`
- `render.ts` — validate user-supplied vars against the manifest, substitute `{{placeholders}}`, derive `.octets` for IPv4 strings
- `flash.ts` — the lifecycle: render → resolve arduino-cli → ensure core installed → compile → upload, with NDJSON-shaped progress events
- `index.ts` — typed surface

## Templates

Each template is a directory under `firmware/templates/<id>/`:

```
ground-skidsteer-esp32/
  template.json     id, name, target, fqbn, core, vars[]
  sketch.ino        the source, with {{var.key}} placeholders
```

`vars[]` declares typed inputs. `string`, `secret`, `number`, `boolean`. Missing required vars or wrong types fail loudly — no silent coercion.

## BMOC integration

The arduino-cli compile and upload subprocesses each register with BMOC. Window-close or app-quit mid-flash kills them cleanly.

## What's next (not in this branch)

- Pico/Pico 2 flashing via mpremote (separate template kind; uses `core/toolchains/mpremote/`)
- Devices-tab UI to pick a template + fill vars + watch progress (B3)
