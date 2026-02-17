#!/usr/bin/env node
/**
 * Brain Briefing CLI
 *
 * Generate comprehensive project briefings from transcript history
 */

import { BriefingGenerator } from './lib/briefing-generator.js';
import path from 'path';

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let directory = process.cwd();
  let recursive = false;
  let since = null;
  let last = null;
  let format = 'markdown';
  let tasksOnly = false;
  let decisionsOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--recursive' || arg === '-r') {
      recursive = true;
    } else if (arg === '--since') {
      since = args[++i];
    } else if (arg === '--last') {
      last = args[++i];
    } else if (arg === '--format') {
      format = args[++i];
    } else if (arg === '--tasks-only') {
      tasksOnly = true;
    } else if (arg === '--decisions-only') {
      decisionsOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      // Assume it's the directory
      directory = path.resolve(arg);
    }
  }

  try {
    const generator = new BriefingGenerator();
    const briefing = await generator.generateBriefing(directory, {
      recursive,
      since,
      last,
      format,
      tasksOnly,
      decisionsOnly
    });

    console.log(briefing);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Brain Briefing - Generate project briefings from transcript history

Usage:
  brain-briefing [directory] [options]

Arguments:
  directory           Directory to analyze (default: current directory)

Options:
  -r, --recursive     Include child directories
  --since <date>      Filter transcripts since date (YYYY-MM-DD)
  --last <days>       Filter last N days of transcripts
  --format <type>     Output format: markdown (default) or json
  --tasks-only        Show only task information
  --decisions-only    Show only decision history
  -h, --help          Show this help message

Examples:
  # Basic briefing for current directory
  brain-briefing

  # Include child directories
  brain-briefing ~/signal --recursive

  # Last 7 days only
  brain-briefing ~/signal --last 7

  # Since specific date
  brain-briefing ~/signal --since 2026-02-01

  # JSON output
  brain-briefing ~/signal --format json

  # Focus on tasks
  brain-briefing ~/signal --tasks-only

Environment:
  DEBUG=1             Show full error stack traces
`);
}

main();
