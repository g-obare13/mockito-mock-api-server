#!/usr/bin/env node
/**
 * @file Executable entrypoint for the `mock-server` CLI.
 *
 * Delegates to {@link runCli} and translates any thrown error into a non-zero
 * exit code with a concise message.
 */

import { runCli } from './cli.js';

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
