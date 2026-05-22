import { platform } from "node:os";

import { runCommandAsync } from "../toolchains/process.js";

/**
 * Host-side Wi-Fi scan.
 *
 * Asks the laptop/desktop running Helm what SSIDs its own radio sees, so
 * the flash wizard can offer an SSID dropdown instead of forcing the user
 * to type it. The robot will then connect to whichever SSID the user
 * picks — we don't validate that the robot can reach it; the typical
 * "laptop on the bench next to the robot" setup means they're functionally
 * in the same RF spot.
 *
 * Returns `unsupported: true` (with an explanatory hint) on platforms
 * we haven't wired yet, so callers can degrade gracefully to a text input.
 */

export interface WifiNetwork {
  ssid: string;
  /** 0..100 signal strength as reported by the OS, or null if unknown. */
  signal: number | null;
  /** "WPA2", "WPA1 WPA2", "WPA3", "OPEN", etc. Free-form per-OS string. */
  security: string;
  /** "2.4GHz" | "5GHz" | "6GHz" | null when unknown. Useful for filtering
   *  bands the target hardware can't reach (e.g. ESP32 is 2.4-only). */
  band: "2.4GHz" | "5GHz" | "6GHz" | null;
}

export interface WifiScanResult {
  ok: boolean;
  /** Empty when ok=false. Sorted strongest-first. */
  networks: WifiNetwork[];
  /** True when this OS hasn't been wired yet (caller should show "type SSID"). */
  unsupported?: boolean;
  /** One-line cause when ok=false. */
  reason?: string;
}

/** Linux: NetworkManager via nmcli. Most desktop distros ship it. */
async function scanLinux(): Promise<WifiScanResult> {
  const res = await runCommandAsync(
    "nmcli",
    ["-t", "-f", "SSID,SIGNAL,SECURITY,FREQ", "device", "wifi", "list"],
    { timeoutMs: 8000 }
  );
  if (res.error || res.status !== 0) {
    const stderr = (res.stderr || "").toLowerCase();
    if (stderr.includes("not running") || stderr.includes("not authorized")) {
      return {
        ok: false,
        networks: [],
        reason: "NetworkManager isn't running, or this user can't query it",
      };
    }
    if (res.error?.includes("ENOENT")) {
      return {
        ok: false,
        networks: [],
        unsupported: true,
        reason: "nmcli not installed — Helm uses NetworkManager to scan on Linux",
      };
    }
    return {
      ok: false,
      networks: [],
      reason: `nmcli failed: ${(res.stderr || "").slice(0, 200).trim()}`,
    };
  }
  return { ok: true, networks: parseNmcli(res.stdout) };
}

/**
 * nmcli -t (terse) emits one network per line, colon-separated, with any
 * embedded colons in field values backslash-escaped. We honor the escape
 * so an SSID containing ":" doesn't shred our parse.
 */
export function parseNmcli(stdout: string): WifiNetwork[] {
  const out: WifiNetwork[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const fields = splitNmcliLine(line);
    if (fields.length < 4) continue;
    const [ssid, signalRaw, security, freqRaw] = fields;
    if (!ssid) continue; // hidden network; user can still type SSID manually
    // Dedupe — nmcli sometimes lists the same SSID once per BSSID.
    if (seen.has(ssid)) continue;
    seen.add(ssid);
    const signal = Number.parseInt(signalRaw, 10);
    const freqMhz = Number.parseInt(freqRaw, 10);
    out.push({
      ssid,
      signal: Number.isFinite(signal) ? signal : null,
      security: security || "OPEN",
      band: bandFromMhz(Number.isFinite(freqMhz) ? freqMhz : null),
    });
  }
  out.sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
  return out;
}

function splitNmcliLine(line: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      buf += line[i + 1];
      i++;
      continue;
    }
    if (ch === ":") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function bandFromMhz(mhz: number | null): WifiNetwork["band"] {
  if (mhz === null) return null;
  if (mhz >= 2400 && mhz <= 2500) return "2.4GHz";
  if (mhz >= 5000 && mhz <= 5900) return "5GHz";
  if (mhz >= 5925 && mhz <= 7125) return "6GHz";
  return null;
}

export async function scan(): Promise<WifiScanResult> {
  const os = platform();
  if (os === "linux") return scanLinux();
  if (os === "darwin") {
    return {
      ok: false,
      networks: [],
      unsupported: true,
      reason:
        "macOS Wi-Fi scan isn't wired yet — type the SSID manually or paste from your menu bar",
    };
  }
  if (os === "win32") {
    return {
      ok: false,
      networks: [],
      unsupported: true,
      reason: "Windows Wi-Fi scan isn't wired yet — type the SSID manually",
    };
  }
  return {
    ok: false,
    networks: [],
    unsupported: true,
    reason: `Wi-Fi scan not implemented for ${os}`,
  };
}
