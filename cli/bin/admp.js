#!/usr/bin/env node
import('../dist/index.js').catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
