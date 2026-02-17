#!/usr/bin/env bun
/**
 * brain-briefing.ts — Generate a situational awareness report for the current brain.
 *
 * Usage:
 *   bun .claude/skills/brain-briefing/brain-briefing.ts [--json]
 *
 * Gathers: identity, git status, test health, workqueue, cross-brain inbox,
 * recent commits, daily log, and surfaces alerts.
 */

import { $ } from "bun";

const JSON_MODE = process.argv.includes("--json");

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tryRead(path: string): Promise<string | null> {
  try {
    const f = Bun.file(path);
    if (await f.exists()) return await f.text();
    return null;
  } catch {
    return null;
  }
}

async function shell(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const result = await $`${{ raw: cmd.join(" ") }} 2>&1`.quiet().nothrow();
    return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function extractField(md: string, field: string): string {
  const re = new RegExp(`\\*\\*${field}\\*\\*:\\s*(.+)`, "i");
  const m = md.match(re);
  return m ? m[1].trim() : "unknown";
}

function countPattern(md: string, pattern: RegExp): number {
  const matches = md.match(pattern);
  return matches ? matches.length : 0;
}

// ── Data Gathering ───────────────────────────────────────────────────────────

const projectRoot = process.cwd();
const today = new Date().toISOString().slice(0, 10);

// Run independent gathers in parallel
const [
  memoryMd,
  workqueueMd,
  dailyMd,
  gitStatus,
  gitBranch,
  gitLog,
  inbox,
  testResult,
  typecheckResult,
  packageJson,
] = await Promise.all([
  tryRead(`${projectRoot}/memory/MEMORY.md`),
  tryRead(`${projectRoot}/memory/WORKQUEUE.md`),
  tryRead(`${projectRoot}/memory/daily/${today}.md`),
  shell(["git", "status", "--porcelain"]),
  shell(["git", "branch", "--show-current"]),
  shell(["git", "log", "--oneline", "-5"]),
  shell(["bun", ".claude/skills/cross-brain-message/brain-msg.ts", "inbox"]),
  shell(["bun", "test"]),
  shell(["bun", "run", "typecheck"]),
  tryRead(`${projectRoot}/package.json`),
]);

// ── Parse Results ────────────────────────────────────────────────────────────

// Identity
const name = memoryMd ? extractField(memoryMd, "Name") : "unknown";
const agentId = memoryMd ? extractField(memoryMd, "Agent ID") : "unknown";
const role = memoryMd ? extractField(memoryMd, "Role") : "unknown";
const version = memoryMd ? extractField(memoryMd, "Version") : "unknown";
const status = memoryMd ? extractField(memoryMd, "State") : "unknown";

// Package
let pkgName = "unknown";
let pkgVersion = "unknown";
if (packageJson) {
  try {
    const pkg = JSON.parse(packageJson);
    pkgName = pkg.name ?? "unknown";
    pkgVersion = pkg.version ?? "unknown";
  } catch { /* ignore */ }
}

// Git
const branch = gitBranch.ok ? gitBranch.out : "unknown";
const dirtyFiles = gitStatus.ok && gitStatus.out ? gitStatus.out.split("\n").length : 0;
const recentCommits = gitLog.ok ? gitLog.out : "none";

// Tests
const testsPassing = testResult.ok;
const testSummaryMatch = testResult.out.match(/(\d+)\s+pass/);
const testFailMatch = testResult.out.match(/(\d+)\s+fail/);
const expectMatch = testResult.out.match(/(\d+)\s+expect\(\)/);
const passCount = testSummaryMatch ? testSummaryMatch[1] : "?";
const failCount = testFailMatch ? testFailMatch[1] : "?";
const expectCount = expectMatch ? expectMatch[1] : "?";

// Typecheck
const typecheckClean = typecheckResult.ok;

// Inbox
const inboxEmpty = inbox.out.toLowerCase().includes("empty");
const inboxMessages = inboxEmpty ? 0 : (inbox.out.split("\n").filter(l => l.trim()).length);

// Workqueue
let activeObjective = "none";
let activeStatus = "none";
let queuedCount = 0;
if (workqueueMd) {
  const objMatch = workqueueMd.match(/###\s+(.+)\n\*\*Why\*\*/);
  if (objMatch) activeObjective = objMatch[1].trim();
  const statusMatch = workqueueMd.match(/\*\*Status\*\*:\s*(.+)/);
  if (statusMatch) activeStatus = statusMatch[1].trim();
  queuedCount = countPattern(workqueueMd, /^###\s+\d+\.\s+/gm);
}

// Alerts
const alerts: string[] = [];
if (!testsPassing) alerts.push("TESTS FAILING");
if (!typecheckClean) alerts.push("TYPECHECK ERRORS");
if (dirtyFiles > 0) alerts.push(`${dirtyFiles} uncommitted file(s)`);
if (!inboxEmpty) alerts.push(`${inboxMessages} unread message(s) in inbox`);

// ── Output ───────────────────────────────────────────────────────────────────

if (JSON_MODE) {
  const report = {
    timestamp: new Date().toISOString(),
    identity: { name, agentId, role, package: pkgName, version: pkgVersion },
    health: {
      tests: { passing: testsPassing, pass: passCount, fail: failCount, assertions: expectCount },
      typecheck: typecheckClean,
    },
    git: { branch, dirtyFiles, recentCommits: recentCommits.split("\n") },
    inbox: { empty: inboxEmpty, count: inboxMessages },
    workqueue: { activeObjective, activeStatus, queuedCount },
    alerts,
  };
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = "─".repeat(60);
  const alertBanner = alerts.length > 0
    ? `\n  ALERTS: ${alerts.join(" | ")}\n`
    : "\n  No alerts. All systems normal.\n";

  console.log(`
${line}
  BRAIN BRIEFING — ${today}
${line}
${alertBanner}
  IDENTITY
    Name:      ${name}
    Agent ID:  ${agentId}
    Role:      ${role}
    Package:   ${pkgName}@${pkgVersion}

  PROJECT HEALTH
    Tests:     ${testsPassing ? "PASS" : "FAIL"} (${passCount} pass, ${failCount} fail, ${expectCount} assertions)
    Typecheck: ${typecheckClean ? "CLEAN" : "ERRORS"}
    Git:       ${branch} branch, ${dirtyFiles} uncommitted file(s)

  CROSS-BRAIN INBOX
    ${inboxEmpty ? "Empty — no pending messages" : `${inboxMessages} message(s) pending`}

  WORKQUEUE
    Active:    ${activeObjective} [${activeStatus}]
    Queued:    ${queuedCount} objective(s) waiting

  RECENT COMMITS
${recentCommits.split("\n").map(l => `    ${l}`).join("\n")}

  TODAY'S LOG
    ${dailyMd && !dailyMd.includes("No sessions recorded") ? "Activity recorded" : "No sessions recorded yet"}
${line}
`);
}
