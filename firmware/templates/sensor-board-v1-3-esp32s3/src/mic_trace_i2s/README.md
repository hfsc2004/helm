# Instrumented microphone I2S wrapper

Source: Espressif Arduino ESP32 3.3.7 `libraries/ESP_I2S/src`.
Upstream: https://github.com/espressif/arduino-esp32/tree/3.3.7/libraries/ESP_I2S/src
License: LGPL 2.1, retained in LICENSE.md.

The class is renamed MicTraceI2SClass so the installed SDK and speaker wrapper
remain untouched. Public types come from the SDK header. Algorithms, defaults,
and call order are unchanged. Only initPDMrx() calls are wrapped to report their
return value and invoke a diagnostic checkpoint after each operation. The hook
is inactive outside the opt-in restore-trace task. The declaration is copied
from the same SDK class; wav_header.h is the upstream WAV helper. Reconcile this
copy with the SDK when upgrading Arduino ESP32. This is instrumentation, not a
replacement microphone initialization sequence.
