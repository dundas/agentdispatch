/**
 * Brain Tools - Unified exports
 *
 * Tools that give the brain autonomous capabilities:
 * - Teleportation: Code changes via Claude Code
 * - ThinkBrowse: Web research and analysis
 */

import {
  TeleportationClient,
  createTeleportationClient,
  type CodingTask,
  type CodingResult,
  type TeleportationSession
} from './teleportation';

import {
  ThinkBrowseClient,
  createThinkBrowseClient,
  type BrowseSession,
  type NavigationResult,
  type ExtractionResult,
  type ScreenshotResult,
  type AnalysisResult
} from './thinkbrowse';

// Re-export everything
export {
  TeleportationClient,
  createTeleportationClient,
  type CodingTask,
  type CodingResult,
  type TeleportationSession,
  ThinkBrowseClient,
  createThinkBrowseClient,
  type BrowseSession,
  type NavigationResult,
  type ExtractionResult,
  type ScreenshotResult,
  type AnalysisResult
};

/**
 * Brain Tools Interface
 *
 * All tools available to a brain for autonomous operation
 */
export interface BrainTools {
  teleportation: TeleportationClient | null;
  thinkbrowse: ThinkBrowseClient | null;
}

/**
 * Initialize all brain tools
 */
export function initializeBrainTools(): BrainTools {
  // Teleportation (for coding)
  let teleportation: TeleportationClient | null = null;
  if (process.env.TELEPORTATION_RELAY_URL || process.env.TELEPORTATION_API_KEY) {
    teleportation = createTeleportationClient();
    console.log('[Tools] Teleportation client initialized');
  } else {
    console.log('[Tools] Teleportation disabled (no TELEPORTATION_RELAY_URL)');
  }

  // ThinkBrowse (for research)
  let thinkbrowse: ThinkBrowseClient | null = null;
  if (process.env.THINKBROWSE_API_URL || process.env.MECH_API_KEY) {
    thinkbrowse = createThinkBrowseClient();
    console.log('[Tools] ThinkBrowse client initialized');
  } else {
    console.log('[Tools] ThinkBrowse disabled (no THINKBROWSE_API_URL)');
  }

  return { teleportation, thinkbrowse };
}
