#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((err) => {
  // Last-resort handler; cli.ts catches structured errors.
  console.error(err);
  process.exit(1);
});
