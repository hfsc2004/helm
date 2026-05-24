// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { scan as scanWifi } from "../../core/wifi/scan.js";

const wifiScan: RuntimeCommand = {
  def: {
    name: "wifi-scan",
    summary:
      "Scan Wi-Fi networks visible to this host. Linux uses nmcli; other platforms not yet wired.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]! },
  },
  async run() {
    const result = await scanWifi();
    emit(result);
    return result.ok ? 0 : 1;
  },
};

register(wifiScan);
