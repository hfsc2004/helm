// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
/**
 * Logger shim for the verbatim download files.
 *
 * The original modules in PSF Core call `logger.info(...)` / `logger.debug(...)`
 * etc. Here we map them to plain stderr writes so they never pollute the
 * NDJSON stream on stdout that agents consume.
 *
 * Intentionally tiny. Do not grow into a full logging framework. If Helm
 * eventually needs structured logging, route through a real module and
 * update this shim to delegate.
 */

'use strict';

function emit(level, message, meta) {
  const ts = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] [download] [${level}] ${message} ${JSON.stringify(meta)}\n`
    : `[${ts}] [download] [${level}] ${message}\n`;
  process.stderr.write(line);
}

module.exports = {
  info:  (msg, meta) => emit('info',  msg, meta),
  warn:  (msg, meta) => emit('warn',  msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
  log:   (msg, meta) => emit('info',  msg, meta),
};
