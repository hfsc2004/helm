// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { emit } from "../output.js";
import { register, type RuntimeCommand } from "../registry.js";
import { COMMON_EXIT_CODES } from "../../core/schema.js";
import {
  detectHardware,
  classifyForInference,
  selectNvidiaGpu,
} from "../../core/hardware/index.js";

const command: RuntimeCommand = {
  def: {
    name: "hardware",
    summary:
      "Detect installed GPUs and report the inference classification (headless-first NVIDIA selection).",
    args: [],
    flags: [],
    streams: false,
    events: [],
    exitCodes: { 0: COMMON_EXIT_CODES[0]!, 1: COMMON_EXIT_CODES[1]! },
  },
  async run() {
    try {
      const hw = await detectHardware(process.cwd());
      const classification = classifyForInference(hw);
      const selection =
        classification.accelerationType === "nvidia"
          ? selectNvidiaGpu(classification)
          : null;
      emit({ hardware: hw, classification, nvidiaSelection: selection });
      return 0;
    } catch (err) {
      emit({
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  },
};

register(command);
export default command;
