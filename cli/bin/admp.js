#!/usr/bin/env node
import('../dist/cli.js').catch(err => {
  if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
    process.stderr.write('dist/cli.js not found — run: bun run build\n');
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message || String(err) : String(err)}\n`);
  }
  process.exit(1);
});
