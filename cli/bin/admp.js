#!/usr/bin/env node
import('../dist/index.js').catch(err => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message || String(err) : String(err)}\n`);
  process.exit(1);
});
