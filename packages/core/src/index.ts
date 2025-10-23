/**
 * ADMP Core Relay Server
 * Main Express application with HTTP API endpoints
 */

import express, { Request, Response } from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { config } from 'dotenv';
import {
  initializeDatabase,
  getPool,
  checkDatabaseConnection,
  closeDatabase,
} from './db.js';
import {
  sendMessage,
  pullMessage,
  ackMessage,
  getInboxStats,
  reclaimExpiredLeases,
} from './inbox.js';
import { authenticateRequest, optionalAuth, AuthenticatedRequest } from './auth.js';
import { SendMessageRequest, PullMessageRequest } from './types.js';

// Load environment variables
config();

const logger = pino({ name: 'admp-relay' });
const app = express();

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 400 && res.statusCode < 500) return 'warn';
      if (res.statusCode >= 500 || err) return 'error';
      return 'info';
    },
  })
);

// Health check endpoint (no auth required)
app.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const dbConnected = await checkDatabaseConnection();

  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'healthy' : 'unhealthy',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    database: dbConnected ? 'connected' : 'disconnected',
  });
});

// SEND - Post a message to an agent's inbox
app.post(
  '/v1/agents/:agentId/messages',
  authenticateRequest,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const messageRequest: SendMessageRequest = {
        ...req.body,
        to: `agent://${agentId}`,
      };

      // Basic validation
      if (!messageRequest.from) {
        res.status(422).json({
          error: 'validation_error',
          message: 'Missing required field: from',
        });
        return;
      }

      if (!messageRequest.subject) {
        res.status(422).json({
          error: 'validation_error',
          message: 'Missing required field: subject',
        });
        return;
      }

      if (!messageRequest.type) {
        res.status(422).json({
          error: 'validation_error',
          message: 'Missing required field: type',
        });
        return;
      }

      if (!messageRequest.body) {
        res.status(422).json({
          error: 'validation_error',
          message: 'Missing required field: body',
        });
        return;
      }

      const messageId = await sendMessage(messageRequest);

      res.status(201).json({
        message_id: messageId,
      });
    } catch (err: any) {
      logger.error({ err }, 'Error sending message');
      res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Failed to send message',
      });
    }
  }
);

// PULL - Retrieve a message from an agent's inbox
app.post(
  '/v1/agents/:agentId/inbox/pull',
  authenticateRequest,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const { visibility_timeout } = req.query;

      const timeout = visibility_timeout
        ? parseInt(visibility_timeout as string, 10)
        : 30;

      if (timeout < 1 || timeout > 3600) {
        res.status(422).json({
          error: 'validation_error',
          message: 'visibility_timeout must be between 1 and 3600 seconds',
        });
        return;
      }

      const message = await pullMessage(agentId, timeout);

      if (!message) {
        res.status(204).send();
        return;
      }

      res.status(200).json(message);
    } catch (err: any) {
      logger.error({ err }, 'Error pulling message');
      res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Failed to pull message',
      });
    }
  }
);

// ACK - Acknowledge message processing
app.post(
  '/v1/agents/:agentId/messages/:messageId/ack',
  authenticateRequest,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agentId, messageId } = req.params;

      await ackMessage(messageId, agentId);

      res.status(200).json({
        status: 'acked',
      });
    } catch (err: any) {
      if (err.message.includes('not found')) {
        res.status(404).json({
          error: 'not_found',
          message: err.message,
        });
        return;
      }

      logger.error({ err }, 'Error acknowledging message');
      res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Failed to acknowledge message',
      });
    }
  }
);

// Inbox stats - Get statistics about an agent's inbox
app.get(
  '/v1/agents/:agentId/inbox/stats',
  authenticateRequest,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const stats = await getInboxStats(agentId);

      res.status(200).json(stats);
    } catch (err: any) {
      logger.error({ err }, 'Error getting inbox stats');
      res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Failed to get inbox stats',
      });
    }
  }
);

// Reclaim expired leases - Manual trigger endpoint
app.post(
  '/v1/agents/:agentId/inbox/reclaim',
  authenticateRequest,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reclaimedCount = await reclaimExpiredLeases();

      res.status(200).json({
        reclaimed: reclaimedCount,
      });
    } catch (err: any) {
      logger.error({ err }, 'Error reclaiming leases');
      res.status(500).json({
        error: 'internal_error',
        message: err.message || 'Failed to reclaim leases',
      });
    }
  }
);

// Background job to reclaim expired leases
function startLeaseReclaimJob() {
  const intervalSec = parseInt(process.env.LEASE_RECLAIM_INTERVAL_SEC || '30', 10);

  setInterval(async () => {
    try {
      await reclaimExpiredLeases();
    } catch (err) {
      logger.error({ err }, 'Background lease reclaim job failed');
    }
  }, intervalSec * 1000);

  logger.info({ intervalSec }, 'Lease reclaim job started');
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  const port = parseInt(process.env.PORT || '3030', 10);
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    logger.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  try {
    // Initialize database
    initializeDatabase(databaseUrl);

    // Wait for database to be ready
    let retries = 10;
    while (retries > 0) {
      const connected = await checkDatabaseConnection();
      if (connected) break;

      logger.info({ retriesLeft: retries }, 'Waiting for database...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      retries--;
    }

    if (retries === 0) {
      logger.error('Failed to connect to database after retries');
      process.exit(1);
    }

    // Start background jobs
    startLeaseReclaimJob();

    // Start HTTP server
    app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'ADMP Relay server started');
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// Only start if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { app };
