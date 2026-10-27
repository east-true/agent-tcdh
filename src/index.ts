#!/usr/bin/env node
import { runCli } from "./cli.js";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Command failed.") + "\n");
  process.exitCode = 1;
}
