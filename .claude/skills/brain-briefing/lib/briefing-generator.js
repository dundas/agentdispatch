/**
 * Briefing Generator
 *
 * Core logic for generating comprehensive project briefings from transcripts
 */

import { TranscriptParser } from '../../transcript-query/lib/transcript-parser.js';
import { TaskCorrelator } from './task-correlator.js';
import { TeamAnalyzer } from './team-analyzer.js';
import fs from 'fs/promises';
import path from 'path';

export class BriefingGenerator {
  constructor() {
    this.transcriptParser = new TranscriptParser();
    this.taskCorrelator = new TaskCorrelator();
    this.teamAnalyzer = new TeamAnalyzer();
  }

  /**
   * Generate briefing for a directory
   */
  async generateBriefing(directory, options = {}) {
    const {
      recursive = false,
      since = null,
      last = null,
      format = 'markdown',
      tasksOnly = false,
      decisionsOnly = false
    } = options;

    console.log(`📊 Generating briefing for: ${directory}`);
    if (recursive) console.log('   Including child directories');

    // 1. Discover all relevant directories
    const directories = await this.discoverDirectories(directory, recursive);
    console.log(`   Found ${directories.length} directories to analyze`);

    // 2. Collect transcripts from all directories
    const allTranscripts = [];
    for (const dir of directories) {
      const transcripts = await this.transcriptParser.listTranscripts(dir);
      for (const transcript of transcripts) {
        allTranscripts.push({ ...transcript, directory: dir });
      }
    }

    // 3. Filter by date if requested
    let filteredTranscripts = allTranscripts;
    if (since) {
      const sinceDate = new Date(since);
      filteredTranscripts = await this.filterByDate(allTranscripts, sinceDate);
    } else if (last) {
      const lastDays = parseInt(last);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - lastDays);
      filteredTranscripts = await this.filterByDate(allTranscripts, sinceDate);
    }

    console.log(`   Analyzing ${filteredTranscripts.length} transcripts`);

    // 4. Parse all transcripts
    const parsedTranscripts = [];
    for (const transcript of filteredTranscripts) {
      try {
        const data = await this.transcriptParser.parseTranscript(transcript.path);
        parsedTranscripts.push({ ...transcript, data });
      } catch (err) {
        console.error(`   ⚠️  Failed to parse ${transcript.sessionId}: ${err.message}`);
      }
    }

    // 5. Correlate with tasks
    const taskAnalysis = await this.taskCorrelator.correlate(parsedTranscripts);

    // 6. Analyze agent teams
    const teamAnalysis = await this.teamAnalyzer.analyze(parsedTranscripts);

    // 7. Extract key information
    const briefingData = {
      metadata: {
        directory,
        recursive,
        childDirectories: directories.filter(d => d !== directory),
        generated: new Date().toISOString(),
        transcriptCount: parsedTranscripts.length,
        daysCovered: this.calculateDaysCovered(parsedTranscripts)
      },
      summary: this.generateSummary(parsedTranscripts, taskAnalysis),
      tasks: taskAnalysis,
      sessions: this.extractSessions(parsedTranscripts),
      teams: teamAnalysis,
      decisions: this.extractDecisions(parsedTranscripts),
      files: this.analyzeFileModifications(parsedTranscripts),
      recommendations: this.generateRecommendations(taskAnalysis, parsedTranscripts)
    };

    // 8. Format output
    if (format === 'json') {
      return JSON.stringify(briefingData, null, 2);
    } else {
      return this.formatMarkdown(briefingData, { tasksOnly, decisionsOnly });
    }
  }

  /**
   * Discover directories (including children if recursive)
   */
  async discoverDirectories(baseDir, recursive) {
    const directories = [path.resolve(baseDir)];

    if (recursive) {
      try {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            directories.push(path.resolve(baseDir, entry.name));
          }
        }
      } catch (err) {
        console.error(`   ⚠️  Failed to read directory: ${err.message}`);
      }
    }

    return directories;
  }

  /**
   * Normalize path to match Claude Code's transcript directory naming
   * Converts /Users/foo/my_project to -Users-foo-my-project
   */
  normalizePath(dirPath) {
    // Claude Code replaces both / and _ with -
    return dirPath.replace(/[/_]/g, '-');
  }

  /**
   * Filter transcripts by date
   */
  async filterByDate(transcripts, sinceDate) {
    const filtered = [];
    for (const transcript of transcripts) {
      try {
        const stats = await fs.stat(transcript.path);
        if (stats.mtime >= sinceDate) {
          filtered.push(transcript);
        }
      } catch (err) {
        console.error(`   ⚠️  Failed to stat ${transcript.path}: ${err.message}`);
      }
    }
    return filtered;
  }

  /**
   * Calculate days covered by transcripts
   */
  calculateDaysCovered(transcripts) {
    if (transcripts.length === 0) return 0;

    const timestamps = transcripts
      .map(t => new Date(t.data.startTime))
      .filter(Boolean)
      .sort((a, b) => a - b);

    if (timestamps.length < 2) return 1;

    const oldest = timestamps[0];
    const newest = timestamps[timestamps.length - 1];
    const diffMs = newest - oldest;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Generate executive summary
   */
  generateSummary(transcripts, taskAnalysis) {
    const totalFiles = new Set();
    transcripts.forEach(t => {
      t.data.filesModified.forEach(f => totalFiles.add(f.path));
    });

    return {
      transcripts: transcripts.length,
      tasks: {
        total: taskAnalysis.allTasks.length,
        completed: taskAnalysis.completed.length,
        inProgress: taskAnalysis.inProgress.length,
        pending: taskAnalysis.pending.length
      },
      filesModified: totalFiles.size,
      branches: [...new Set(transcripts.map(t => t.data.gitBranch).filter(Boolean))]
    };
  }

  /**
   * Extract session information
   */
  extractSessions(transcripts) {
    return transcripts
      .map(t => ({
        sessionId: t.data.sessionId,
        startTime: t.data.startTime,
        duration: this.formatDuration(t.data.summary.durationMs),
        branch: t.data.gitBranch,
        directory: t.directory,
        messageCount: t.data.summary.messageCount,
        filesModified: t.data.filesModified.length,
        tasksCompleted: this.extractTaskIDs(t.data, 'completed'),
        errors: t.data.errors.length
      }))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  }

  /**
   * Extract task IDs from transcript
   */
  extractTaskIDs(transcriptData, status = null) {
    const taskIds = new Set();
    const pattern = /task[#\s]+(\d+)/gi;

    transcriptData.messages.forEach(msg => {
      const matches = msg.content.matchAll(pattern);
      for (const match of matches) {
        taskIds.add(match[1]);
      }
    });

    return Array.from(taskIds);
  }

  /**
   * Extract key decisions
   */
  extractDecisions(transcripts) {
    const decisions = [];
    const decisionKeywords = [
      'decided', 'chose', 'selected', 'rejected', 'alternative',
      'rationale', 'because', 'instead of', 'better to'
    ];

    for (const transcript of transcripts) {
      for (const msg of transcript.data.messages) {
        if (msg.type === 'assistant' && decisionKeywords.some(kw =>
          msg.content.toLowerCase().includes(kw)
        )) {
          // Extract decision context
          const lines = msg.content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            if (decisionKeywords.some(kw => line.includes(kw))) {
              decisions.push({
                sessionId: transcript.data.sessionId,
                timestamp: msg.timestamp,
                context: lines.slice(Math.max(0, i - 2), i + 3).join('\n'),
                branch: transcript.data.gitBranch
              });
              break;
            }
          }
        }
      }
    }

    return decisions;
  }

  /**
   * Analyze file modifications
   */
  analyzeFileModifications(transcripts) {
    const fileStats = new Map();

    for (const transcript of transcripts) {
      for (const file of transcript.data.filesModified) {
        if (!fileStats.has(file.path)) {
          fileStats.set(file.path, {
            path: file.path,
            modifications: 0,
            sessions: new Set(),
            lastModified: null
          });
        }

        const stats = fileStats.get(file.path);
        stats.modifications++;
        stats.sessions.add(transcript.data.sessionId);

        if (!stats.lastModified || file.timestamp > stats.lastModified) {
          stats.lastModified = file.timestamp;
        }
      }
    }

    // Convert to array and sort by modification frequency
    return Array.from(fileStats.values())
      .map(s => ({ ...s, sessions: s.sessions.size }))
      .sort((a, b) => b.modifications - a.modifications)
      .slice(0, 10); // Top 10
  }

  /**
   * Generate recommendations
   */
  generateRecommendations(taskAnalysis, transcripts) {
    const recommendations = [];

    // Check for blocked tasks
    if (taskAnalysis.blocked.length > 0) {
      recommendations.push({
        type: 'blocker',
        priority: 'high',
        message: `${taskAnalysis.blocked.length} tasks are blocked. Review dependencies.`
      });
    }

    // Check for stale in_progress tasks
    const staleInProgress = taskAnalysis.inProgress.filter(t => {
      // Task in progress for > 7 days
      const lastUpdate = new Date(t.lastUpdate || 0);
      const daysSince = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
      return daysSince > 7;
    });

    if (staleInProgress.length > 0) {
      recommendations.push({
        type: 'stale',
        priority: 'medium',
        message: `${staleInProgress.length} tasks in_progress for >7 days. Review status.`
      });
    }

    // Check for error patterns
    const totalErrors = transcripts.reduce((sum, t) => sum + t.data.errors.length, 0);
    if (totalErrors > 10) {
      recommendations.push({
        type: 'errors',
        priority: 'high',
        message: `${totalErrors} errors in recent sessions. Investigate patterns.`
      });
    }

    return recommendations;
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(ms) {
    if (!ms) return '0s';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format output as markdown
   */
  formatMarkdown(data, options = {}) {
    const { tasksOnly, decisionsOnly } = options;

    let md = `# Brain Briefing: ${data.metadata.directory}\n\n`;
    md += `**Generated**: ${new Date(data.metadata.generated).toLocaleString()}\n`;
    md += `**Transcripts**: ${data.metadata.transcriptCount} sessions`;
    if (data.metadata.daysCovered) {
      md += ` (${data.metadata.daysCovered} days)`;
    }
    md += `\n`;
    md += `**Tasks**: ${data.summary.tasks.total} total (${data.summary.tasks.completed} completed, ${data.summary.tasks.inProgress} in_progress, ${data.summary.tasks.pending} pending)\n\n`;

    if (data.metadata.childDirectories.length > 0) {
      md += `**Child Directories**: ${data.metadata.childDirectories.length}\n`;
      data.metadata.childDirectories.forEach(d => {
        md += `  - ${d}\n`;
      });
      md += `\n`;
    }

    md += `---\n\n`;

    // Tasks section
    if (!decisionsOnly) {
      md += `## Active Tasks (${data.tasks.inProgress.length + data.tasks.pending.length})\n\n`;

      [...data.tasks.inProgress, ...data.tasks.pending].slice(0, 5).forEach(task => {
        md += `### #${task.id} [${task.status}] ${task.subject}\n`;
        if (task.owner) md += `- **Owner**: ${task.owner}\n`;
        if (task.sessionId) md += `- **Session**: ${task.sessionId.substring(0, 8)}...\n`;
        if (task.blockedBy && task.blockedBy.length > 0) {
          md += `- **Blocked by**: ${task.blockedBy.join(', ')}\n`;
        } else {
          md += `- **Blocked by**: None\n`;
        }
        md += `\n`;
      });

      md += `---\n\n`;
    }

    // Decisions section
    if (!tasksOnly) {
      md += `## Key Decisions (${Math.min(5, data.decisions.length)})\n\n`;

      data.decisions.slice(0, 5).forEach((decision, i) => {
        md += `### ${i + 1}. Decision (${new Date(decision.timestamp).toLocaleDateString()})\n`;
        md += `**Session**: ${decision.sessionId.substring(0, 8)}...\n`;
        if (decision.branch) md += `**Branch**: ${decision.branch}\n`;
        md += `\n`;
        md += `${decision.context}\n\n`;
      });

      md += `---\n\n`;
    }

    // File modifications
    if (!tasksOnly && !decisionsOnly) {
      md += `## File Modification Frequency (Top 10)\n\n`;
      md += `| File | Modifications | Sessions |\n`;
      md += `|------|---------------|----------|\n`;

      data.files.forEach(file => {
        const fileName = file.path.length > 50
          ? '...' + file.path.substring(file.path.length - 47)
          : file.path;
        md += `| ${fileName} | ${file.modifications} | ${file.sessions} |\n`;
      });

      md += `\n---\n\n`;
    }

    // Recommendations
    if (data.recommendations.length > 0) {
      md += `## Recommendations\n\n`;
      data.recommendations.forEach((rec, i) => {
        const icon = rec.priority === 'high' ? '🔴' : '🟡';
        md += `${i + 1}. ${icon} **${rec.type.toUpperCase()}**: ${rec.message}\n`;
      });
      md += `\n`;
    }

    md += `---\n\n`;
    md += `**Generated by**: brain-briefing v1.0\n`;

    return md;
  }
}
