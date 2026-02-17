/**
 * Task Correlator
 *
 * Correlates tasks from ~/.claude/tasks/ with transcript sessions
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class TaskCorrelator {
  constructor() {
    this.tasksDir = path.join(os.homedir(), '.claude', 'tasks');
  }

  /**
   * Correlate tasks with transcripts
   */
  async correlate(transcripts) {
    // 1. Read all tasks from ~/.claude/tasks/
    const allTasks = await this.loadTasks();

    // 2. Extract task IDs mentioned in transcripts
    const transcriptTaskMentions = new Map();
    for (const transcript of transcripts) {
      const taskIds = this.extractTaskIds(transcript.data);
      for (const taskId of taskIds) {
        if (!transcriptTaskMentions.has(taskId)) {
          transcriptTaskMentions.set(taskId, []);
        }
        transcriptTaskMentions.get(taskId).push({
          sessionId: transcript.data.sessionId,
          timestamp: transcript.data.startTime
        });
      }
    }

    // 3. Correlate tasks with sessions
    const correlatedTasks = allTasks.map(task => ({
      ...task,
      sessions: transcriptTaskMentions.get(task.id) || [],
      lastSession: (transcriptTaskMentions.get(task.id) || []).sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
      )[0]
    }));

    // 4. Categorize by status
    return {
      allTasks: correlatedTasks,
      completed: correlatedTasks.filter(t => t.status === 'completed'),
      inProgress: correlatedTasks.filter(t => t.status === 'in_progress'),
      pending: correlatedTasks.filter(t => t.status === 'pending'),
      blocked: correlatedTasks.filter(t =>
        t.status === 'pending' && t.blockedBy && t.blockedBy.length > 0
      )
    };
  }

  /**
   * Load all tasks from ~/.claude/tasks/
   */
  async loadTasks() {
    try {
      // Check if tasks directory exists
      try {
        await fs.access(this.tasksDir);
      } catch {
        // Tasks directory doesn't exist
        return [];
      }

      const tasks = [];
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Each subdirectory is a task list
          const taskListDir = path.join(this.tasksDir, entry.name);
          const taskFiles = await fs.readdir(taskListDir);

          for (const taskFile of taskFiles) {
            if (taskFile.endsWith('.json')) {
              try {
                const taskPath = path.join(taskListDir, taskFile);
                const content = await fs.readFile(taskPath, 'utf-8');
                const task = JSON.parse(content);
                tasks.push({
                  id: taskFile.replace('.json', ''),
                  ...task
                });
              } catch (err) {
                console.error(`   ⚠️  Failed to parse task ${taskFile}: ${err.message}`);
              }
            }
          }
        }
      }

      return tasks;
    } catch (err) {
      console.error(`   ⚠️  Failed to load tasks: ${err.message}`);
      return [];
    }
  }

  /**
   * Extract task IDs from transcript
   */
  extractTaskIds(transcriptData) {
    const taskIds = new Set();

    // Pattern matches: "task #15", "task 15", "Task #15", etc.
    const pattern = /task[#\s]+(\d+)/gi;

    for (const msg of transcriptData.messages) {
      const matches = msg.content.matchAll(pattern);
      for (const match of matches) {
        taskIds.add(match[1]);
      }
    }

    // Also check tool uses for TaskUpdate/TaskCreate
    for (const tool of transcriptData.toolUses) {
      if (tool.tool === 'TaskUpdate' || tool.tool === 'TaskCreate') {
        if (tool.parameters.taskId) {
          taskIds.add(tool.parameters.taskId);
        }
      }
    }

    return Array.from(taskIds);
  }
}
