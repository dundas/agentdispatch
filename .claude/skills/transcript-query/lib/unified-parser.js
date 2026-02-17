/**
 * Unified Transcript Parser
 *
 * Orchestrates discovery and parsing across all 4 CLI transcript formats:
 * Claude Code, Codex, Cursor, Gemini CLI
 *
 * Reuses search/analysis from the existing TranscriptParser.
 */

import { ClaudeAdapter } from './adapters/claude-adapter.js';
import { CodexAdapter } from './adapters/codex-adapter.js';
import { CursorAdapter } from './adapters/cursor-adapter.js';
import { GeminiAdapter } from './adapters/gemini-adapter.js';
import { TranscriptParser } from './transcript-parser.js';

export class UnifiedTranscriptParser {
  constructor() {
    this.adapters = {
      claude: new ClaudeAdapter(),
      codex: new CodexAdapter(),
      cursor: new CursorAdapter(),
      gemini: new GeminiAdapter()
    };
    this.legacyParser = new TranscriptParser();
    this.cache = new Map();
  }

  /**
   * Discover transcripts across all CLIs for a project
   * @param {string} projectPath - Absolute or relative project path
   * @param {object} options - { cli: string[] } to filter by CLI
   * @returns {Array<{cli, sessionId, path, mtime}>}
   */
  async discoverAll(projectPath, options = {}) {
    const cliFilter = options.cli
      ? (Array.isArray(options.cli) ? options.cli : [options.cli])
      : Object.keys(this.adapters);

    const results = await Promise.allSettled(
      cliFilter.map(async (cli) => {
        const adapter = this.adapters[cli];
        if (!adapter) return [];
        try {
          return await adapter.discover(projectPath);
        } catch (err) {
          console.error(`[${cli}] Discovery error: ${err.message}`);
          return [];
        }
      })
    );

    const transcripts = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // Sort by modification time, most recent first
    transcripts.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    return transcripts;
  }

  /**
   * Parse a specific session
   * @param {string} cli - CLI name
   * @param {string} filePath - Path to transcript file
   * @returns {object} Normalized transcript data
   */
  async parseSession(cli, filePath) {
    const cacheKey = `${cli}:${filePath}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      try {
        const stats = await (await import('fs/promises')).stat(filePath);
        if (stats.mtime.getTime() <= cached.mtime) return cached.data;
      } catch {
        this.cache.delete(cacheKey);
      }
    }

    const adapter = this.adapters[cli];
    if (!adapter) throw new Error(`Unknown CLI: ${cli}`);

    const data = await adapter.parse(filePath);

    // Cache result
    try {
      const stats = await (await import('fs/promises')).stat(filePath);
      this.cache.set(cacheKey, { data, mtime: stats.mtime.getTime() });
    } catch { /* ignore */ }

    return data;
  }

  /**
   * Get chronological timeline of all sessions across CLIs
   * @param {string} projectPath
   * @param {object} options - { since, until, cli, limit }
   */
  async getTimeline(projectPath, options = {}) {
    const discovered = await this.discoverAll(projectPath, options);

    // Filter by date range
    let filtered = discovered;
    if (options.since) {
      const since = new Date(options.since);
      filtered = filtered.filter(t => new Date(t.mtime) >= since);
    }
    if (options.until) {
      const until = new Date(options.until);
      filtered = filtered.filter(t => new Date(t.mtime) <= until);
    }

    // Apply limit
    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    // Parse all sessions
    const sessions = await Promise.allSettled(
      filtered.map(async (t) => {
        const data = await this.parseSession(t.cli, t.path);
        return { ...t, data };
      })
    );

    return sessions
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => {
        const aTime = a.data.startTime || a.mtime;
        const bTime = b.data.startTime || b.mtime;
        return new Date(bTime) - new Date(aTime);
      });
  }

  /**
   * Search across all CLIs
   * @param {string} projectPath
   * @param {string} keyword
   * @param {object} options - { cli, limit, since }
   */
  async searchAll(projectPath, keyword, options = {}) {
    const timeline = await this.getTimeline(projectPath, {
      ...options,
      limit: options.limit || 30
    });

    const results = [];

    for (const session of timeline) {
      const matches = this.legacyParser.searchMessages(session.data, keyword);
      if (matches.length > 0) {
        results.push({
          cli: session.cli,
          sessionId: session.sessionId,
          path: session.path,
          mtime: session.mtime,
          data: session.data,
          matches
        });
      }
    }

    // Sort by best match score
    results.sort((a, b) => b.matches[0].score - a.matches[0].score);

    return results;
  }

  /**
   * Get aggregate summary across all CLIs
   */
  async getSummary(projectPath, options = {}) {
    const discovered = await this.discoverAll(projectPath, options);

    const summary = {
      total: discovered.length,
      byCli: {},
      dateRange: { earliest: null, latest: null }
    };

    for (const cli of Object.keys(this.adapters)) {
      const cliTranscripts = discovered.filter(t => t.cli === cli);
      summary.byCli[cli] = {
        count: cliTranscripts.length,
        latest: cliTranscripts[0]?.mtime || null
      };
    }

    if (discovered.length > 0) {
      const sorted = [...discovered].sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
      summary.dateRange.earliest = sorted[0].mtime;
      summary.dateRange.latest = sorted[sorted.length - 1].mtime;
    }

    return summary;
  }

  /**
   * Get the most recent session across all CLIs
   */
  async getMostRecent(projectPath) {
    const discovered = await this.discoverAll(projectPath);
    if (discovered.length === 0) return null;

    const most = discovered[0]; // Already sorted by mtime desc
    const data = await this.parseSession(most.cli, most.path);
    return { ...most, data };
  }
}
