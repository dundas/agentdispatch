/**
 * ADMP Server
 * Agent Dispatch Messaging Protocol - Universal inbox for autonomous agents
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { config } from 'dotenv';

import agentRoutes from './routes/agents.js';
import inboxRoutes from './routes/inbox.js';
import { requireApiKey } from './middleware/auth.js';
import { agentService } from './services/agent.service.js';
import { inboxService } from './services/inbox.service.js';
import { storage } from './storage/memory.js';

// Load environment variables
config();

const PORT = process.env.PORT || 8080;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 60000;

// Initialize logger
const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
});

// Initialize Express
const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

// Optional API key authentication
if (process.env.API_KEY_REQUIRED === 'true') {
  logger.info('API key authentication enabled');
  app.use('/api', requireApiKey);
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await storage.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'STATS_FAILED',
      message: error.message
    });
  }
});

// Routes
app.use('/api/agents', agentRoutes);
app.use('/api/agents', inboxRoutes);
app.use('/api', inboxRoutes);  // For /api/messages/:id/status

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'Endpoint not found'
  });
});

// Error handler
app.use((error, req, res, next) => {
  logger.error(error);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
  });
});

// Background jobs
let cleanupTimer;
let heartbeatTimer;

function startBackgroundJobs() {
  logger.info('Starting background jobs');

  // Cleanup job: expire leases and messages
  cleanupTimer = setInterval(async () => {
    try {
      const leasesReclaimed = await inboxService.reclaimExpiredLeases();
      const messagesExpired = await storage.expireMessages();
      const messagesDeleted = await storage.cleanupExpiredMessages();

      if (leasesReclaimed > 0 || messagesExpired > 0 || messagesDeleted > 0) {
        logger.debug({
          leasesReclaimed,
          messagesExpired,
          messagesDeleted
        }, 'Cleanup job completed');
      }
    } catch (error) {
      logger.error(error, 'Cleanup job failed');
    }
  }, CLEANUP_INTERVAL_MS);

  // Heartbeat check job: mark offline agents
  heartbeatTimer = setInterval(async () => {
    try {
      const marked = await agentService.markOfflineAgents();

      if (marked > 0) {
        logger.debug({ marked }, 'Heartbeat check: agents marked offline');
      }
    } catch (error) {
      logger.error(error, 'Heartbeat check failed');
    }
  }, CLEANUP_INTERVAL_MS);

  logger.info('Background jobs started');
}

function stopBackgroundJobs() {
  logger.info('Stopping background jobs');

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  logger.info('Background jobs stopped');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  stopBackgroundJobs();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  stopBackgroundJobs();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Start server
const server = app.listen(PORT, () => {
  logger.info(`ADMP server listening on port ${PORT}`);
  logger.info({
    env: process.env.NODE_ENV || 'development',
    heartbeat_interval: process.env.HEARTBEAT_INTERVAL_MS || 60000,
    heartbeat_timeout: process.env.HEARTBEAT_TIMEOUT_MS || 300000,
    message_ttl: process.env.MESSAGE_TTL_SEC || 86400,
    cleanup_interval: CLEANUP_INTERVAL_MS
  }, 'Server configuration');

  startBackgroundJobs();
});

export default app;
