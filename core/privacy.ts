/**
 * PSF Helm privacy posture, machine-readable.
 *
 * If this module ever has to change to allow an outbound destination, the
 * canary in README.md changes at the same time. This module is the source
 * of truth for `helm privacy`.
 */

export interface PrivacyPosture {
  canary: {
    statement: string;
    last_affirmed: string;
    version_affirmed: string;
  };
  outbound_destinations: string[];
  data_collected: string[];
  user_tracking: false;
  cloud_dependencies: string[];
  data_stored_locally: string[];
  data_storage_path: string;
}

export function buildPrivacyPosture(opts: {
  version: string;
  dataPath: string;
}): PrivacyPosture {
  return {
    canary: {
      statement:
        "PSF Helm makes zero outbound network connections except to vehicles on the local network.",
      last_affirmed: "2026-05-15",
      version_affirmed: opts.version,
    },
    outbound_destinations: [],
    data_collected: [],
    user_tracking: false,
    cloud_dependencies: [],
    data_stored_locally: [
      "vehicle-state",
      "command-history",
      "vehicle-registry",
      "traces",
      "errors",
    ],
    data_storage_path: opts.dataPath,
  };
}
