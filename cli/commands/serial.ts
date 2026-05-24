// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import { listSerialPorts } from "../../core/serial/index.js";

const list: RuntimeCommand = {
  def: {
    name: "serial-list",
    summary:
      "List USB/serial devices on the host. Detects raspberry-pi-pico and esp32 boards.",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]! },
  },
  async run() {
    const ports = listSerialPorts();
    emit({ ports });
    return 0;
  },
};

register(list);
