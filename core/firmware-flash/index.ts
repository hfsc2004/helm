/**
 * Firmware flashing.
 *
 * Sketch templates live in <repo>/firmware/templates/<id>/. Each one
 * declares its target board, FQBN, core, and the variables a user needs
 * to fill in to flash it (WiFi creds, motor trims, etc.).
 *
 * The flash flow renders the sketch with the user's vars, ensures the
 * right arduino-cli core is installed, compiles, and uploads — every
 * subprocess registered with BMOC so shutdown reaps cleanly.
 */

export {
  listTemplates,
  loadTemplate,
  type TemplateManifest,
  type TemplateVar,
  type LoadedTemplate,
} from "./templates.js";
export { renderSketch, type VarValue } from "./render.js";
export {
  flash,
  type FlashEvent,
  type FlashRequest,
  type FlashStage,
  type ProgressCallback,
} from "./flash.js";
