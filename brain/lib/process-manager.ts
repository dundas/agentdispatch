/**
 * Brain Process Manager
 *
 * Manages long-running processes within the brain:
 * - Heartbeat loop
 * - Inbox polling
 * - Webhook server
 * - Self-improvement tasks
 * - Custom registered processes
 *
 * Features:
 * - Register processes with configurable behavior
 * - Automatic restart on failure
 * - Health monitoring and status reporting
 * - Graceful shutdown
 */

export type ProcessType = 'interval' | 'persistent' | 'once';
export type ProcessStatus = 'pending' | 'running' | 'stopped' | 'failed' | 'completed';

export interface ProcessConfig {
  /** Unique name for the process */
  name: string;
  /** Function to run */
  run: () => Promise<void> | void;
  /** Process type: interval (repeating), persistent (long-running), once (one-shot) */
  type?: ProcessType;
  /** Interval in ms for 'interval' type processes */
  interval?: number;
  /** Whether to restart on failure */
  restartOnFailure?: boolean;
  /** Maximum number of restarts before marking as failed */
  maxRestarts?: number;
  /** Delay before restart in ms */
  restartDelay?: number;
  /** Whether process is enabled */
  enabled?: boolean;
}

export interface ProcessState {
  name: string;
  type: ProcessType;
  status: ProcessStatus;
  interval?: number;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  errorCount: number;
  lastError?: string;
  restarts: number;
}

export class ProcessManager {
  private processes: Map<string, ProcessConfig> = new Map();
  private states: Map<string, ProcessState> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;

  /**
   * Register a process with the manager
   */
  register(config: ProcessConfig): void {
    const fullConfig: ProcessConfig = {
      type: 'interval',
      restartOnFailure: true,
      maxRestarts: 5,
      restartDelay: 5000,
      enabled: true,
      ...config
    };

    this.processes.set(config.name, fullConfig);
    this.states.set(config.name, {
      name: config.name,
      type: fullConfig.type!,
      status: 'pending',
      interval: fullConfig.interval,
      runCount: 0,
      errorCount: 0,
      restarts: 0
    });

    console.log(`[ProcessManager] Registered: ${config.name} (${fullConfig.type}${fullConfig.interval ? `, ${fullConfig.interval}ms` : ''})`);
  }

  /**
   * Start all registered processes
   */
  start(): void {
    if (this.running) {
      console.log('[ProcessManager] Already running');
      return;
    }

    this.running = true;
    console.log('[ProcessManager] Starting all processes...');

    for (const [name, config] of this.processes) {
      if (config.enabled) {
        this.startProcess(name);
      }
    }

    this.printStatus();
  }

  /**
   * Start a specific process
   */
  private async startProcess(name: string): Promise<void> {
    const config = this.processes.get(name);
    const state = this.states.get(name);

    if (!config || !state) {
      console.error(`[ProcessManager] Process not found: ${name}`);
      return;
    }

    state.status = 'running';

    switch (config.type) {
      case 'interval':
        this.runIntervalProcess(name, config, state);
        break;
      case 'persistent':
        this.runPersistentProcess(name, config, state);
        break;
      case 'once':
        this.runOnceProcess(name, config, state);
        break;
    }
  }

  /**
   * Run an interval-based process
   */
  private async runIntervalProcess(
    name: string,
    config: ProcessConfig,
    state: ProcessState
  ): Promise<void> {
    const runWithCatch = async () => {
      if (!this.running || state.status === 'stopped') return;

      state.lastRun = new Date();
      state.runCount++;

      try {
        await config.run();
        state.nextRun = new Date(Date.now() + (config.interval || 60000));
        // Reset restarts on successful run
        state.restarts = 0;
      } catch (error) {
        state.errorCount++;
        state.lastError = String(error);
        console.error(`[ProcessManager] ${name} error:`, error);

        if (config.restartOnFailure && state.restarts < (config.maxRestarts || 5)) {
          state.restarts++;
          console.log(`[ProcessManager] ${name} will retry (attempt ${state.restarts}/${config.maxRestarts})`);
        } else if (state.restarts >= (config.maxRestarts || 5)) {
          state.status = 'failed';
          console.error(`[ProcessManager] ${name} exceeded max restarts, marking as failed`);
          return;
        }
      }

      // Schedule next run
      if (this.running && state.status === 'running') {
        // Clear any existing timer to prevent leaks
        const existingTimer = this.timers.get(name);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timer = setTimeout(runWithCatch, config.interval || 60000);
        this.timers.set(name, timer);
      }
    };

    // Run immediately, then on interval
    await runWithCatch();
  }

  /**
   * Run a persistent process (like a server)
   */
  private async runPersistentProcess(
    name: string,
    config: ProcessConfig,
    state: ProcessState
  ): Promise<void> {
    state.lastRun = new Date();
    state.runCount++;

    try {
      // Persistent processes are expected to run indefinitely
      // They should only return on error or shutdown
      await config.run();

      // If we get here normally (not from error), mark as completed
      if (state.status === 'running') {
        state.status = 'completed';
      }
    } catch (error) {
      state.errorCount++;
      state.lastError = String(error);
      console.error(`[ProcessManager] ${name} failed:`, error);

      // Restart if enabled and not shutdown
      if (this.running && config.restartOnFailure && state.restarts < (config.maxRestarts || 5)) {
        state.restarts++;
        state.status = 'running';
        console.log(`[ProcessManager] ${name} restarting in ${config.restartDelay}ms (attempt ${state.restarts}/${config.maxRestarts})...`);
        // Clear any existing timer to prevent leaks
        const existingTimer = this.timers.get(name);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => this.runPersistentProcess(name, config, state), config.restartDelay || 5000);
        this.timers.set(name, timer);
      } else if (state.restarts >= (config.maxRestarts || 5)) {
        state.status = 'failed';
        console.error(`[ProcessManager] ${name} exceeded max restarts, marking as failed`);
      }
    }
  }

  /**
   * Run a one-time process
   */
  private async runOnceProcess(
    name: string,
    config: ProcessConfig,
    state: ProcessState
  ): Promise<void> {
    state.lastRun = new Date();
    state.runCount++;

    try {
      await config.run();
      state.status = 'completed';
      console.log(`[ProcessManager] ${name} completed`);
    } catch (error) {
      state.errorCount++;
      state.lastError = String(error);
      state.status = 'failed';
      console.error(`[ProcessManager] ${name} failed:`, error);
    }
  }

  /**
   * Stop all processes
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('[ProcessManager] Stopping all processes...');
    this.running = false;

    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearTimeout(timer);
      const state = this.states.get(name);
      if (state && state.status === 'running') {
        state.status = 'stopped';
      }
    }
    this.timers.clear();

    console.log('[ProcessManager] All processes stopped');
  }

  /**
   * Stop a specific process
   */
  stopProcess(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(name);
    }

    const state = this.states.get(name);
    if (state) {
      state.status = 'stopped';
    }

    console.log(`[ProcessManager] Stopped: ${name}`);
  }

  /**
   * Restart a specific process
   */
  async restartProcess(name: string): Promise<void> {
    this.stopProcess(name);

    const state = this.states.get(name);
    if (state) {
      state.restarts = 0;
      state.errorCount = 0;
      state.lastError = undefined;
    }

    await this.startProcess(name);
    console.log(`[ProcessManager] Restarted: ${name}`);
  }

  /**
   * Get status of all processes
   */
  getStatus(): ProcessState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get status of a specific process
   */
  getProcessStatus(name: string): ProcessState | undefined {
    return this.states.get(name);
  }

  /**
   * Print status table to console
   */
  printStatus(): void {
    const states = this.getStatus();

    console.log('');
    console.log('┌───────────────────────────────────────────────────────────┐');
    console.log('│              Brain Process Manager                        │');
    console.log('├───────────────────────────────────────────────────────────┤');

    if (states.length === 0) {
      console.log('│  No processes registered                                  │');
    } else {
      for (const state of states) {
        const statusIcon = {
          'pending': '⏳',
          'running': '✅',
          'stopped': '⏹️ ',
          'failed': '❌',
          'completed': '✓ '
        }[state.status];

        const info = state.type === 'interval'
          ? `${(state.interval || 0) / 1000}s loop`
          : state.type === 'persistent'
            ? 'persistent'
            : 'once';

        const errors = state.errorCount > 0 ? ` (${state.errorCount} errors)` : '';

        console.log(`│  ${statusIcon} ${state.name.padEnd(18)} ${state.status.padEnd(10)} ${info.padEnd(12)}${errors.padEnd(14)}│`);
      }
    }

    console.log('└───────────────────────────────────────────────────────────┘');
    console.log('');
  }

  /**
   * Check if manager is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get count of running processes
   */
  getRunningCount(): number {
    return Array.from(this.states.values()).filter(s => s.status === 'running').length;
  }

  /**
   * Get count of failed processes
   */
  getFailedCount(): number {
    return Array.from(this.states.values()).filter(s => s.status === 'failed').length;
  }
}

// Singleton instance for convenience
export const processManager = new ProcessManager();
