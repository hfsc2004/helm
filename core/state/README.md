# State

Vehicle state streaming.

This module deals with data the **vehicle** reports about itself — battery voltage, motor speed, signal strength, position, etc. The term "telemetry" appears in internal robotics code because every robotics library on earth uses it; in user-facing surfaces (CLI commands, UI labels, docs) the term is "vehicle state."

Vehicle state is read from the vehicle's local network endpoint and streamed to subscribers (the UI, the CLI's `helm state --follow`, etc.). It is **not** persisted unless the user explicitly opts in.
