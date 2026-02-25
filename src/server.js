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
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import agentRoutes from './routes/agents.js';
import inboxRoutes from './routes/inbox.js';
import groupRoutes from './routes/groups.js';
import outboxRoutes, { outboxWebhookRouter } from './routes/outbox.js';
import discoveryRoutes from './routes/discovery.js';
import keysRoutes from './routes/keys.js';
import { requireApiKey, verifyHttpSignatureOnly } from './middleware/auth.js';
import { agentService } from './services/agent.service.js';
import { inboxService } from './services/inbox.service.js';
import { storage } from './storage/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Load environment variables
config();

const PORT = process.env.PORT || 8080;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 60000;

// Warn about insecure outbox webhook configuration
if (process.env.MAILGUN_API_KEY && !process.env.MAILGUN_WEBHOOK_SIGNING_KEY) {
  console.warn(
    'WARNING: MAILGUN_API_KEY is set but MAILGUN_WEBHOOK_SIGNING_KEY is not. ' +
    'Mailgun webhooks will accept unauthenticated requests. ' +
    'Set MAILGUN_WEBHOOK_SIGNING_KEY for production use.'
  );
}

// Warn when no master key is configured — admin endpoints will deny all requests
if (!process.env.MASTER_API_KEY) {
  console.warn(
    'WARNING: MASTER_API_KEY is not set. ' +
    'Admin endpoints (key issuance, agent approval/rejection) will reject all requests. ' +
    'Set MASTER_API_KEY to enable administrative operations.'
  );
}

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

// API key authentication middleware.
// The middleware is always mounted; enforcement is checked at request time
// by reading API_KEY_REQUIRED, so the flag can be toggled without restart.
logger.info(
  { apiKeyRequired: process.env.API_KEY_REQUIRED === 'true' },
  `API key enforcement: ${process.env.API_KEY_REQUIRED === 'true' ? 'enabled' : 'disabled'} (API_KEY_REQUIRED=${process.env.API_KEY_REQUIRED ?? 'unset'})`
);
app.use('/api', async (req, res, next) => {
  // Always allow agent self-registration without an API key
  if (req.method === 'POST' && req.path === '/agents/register') return next();

  // If request has a valid HTTP Signature, bypass API key requirement.
  // This lets agents authenticate with their registered Ed25519 keypair
  // instead of needing a separate API key.
  if (req.headers['signature']) {
    const result = await verifyHttpSignatureOnly(req);
    if (result.verified) {
      req.agent = result.agent;
      req.authMethod = 'http-signature';
      return next();
    }
    // The presence of a Signature header signals intent to use cryptographic auth.
    // If verification fails, reject immediately — do NOT fall through to API key.
    // This prevents an attacker from bypassing signature checks with a stolen API key.
    return res.status(401).json({
      error: 'SIGNATURE_INVALID',
      message: 'HTTP signature verification failed'
    });
  }

  return requireApiKey(req, res, next);
});

// Load OpenAPI spec
const openapiSpec = YAML.load(join(projectRoot, 'openapi.yaml'));

// API Documentation
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'ADMP API Documentation',
  customfavIcon: '/favicon.ico'
}));

// Serve OpenAPI spec as JSON
app.get('/openapi.json', (req, res) => {
  res.json(openapiSpec);
});

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

// Discovery routes (mounted at root for .well-known and also /api for DID docs)
app.use(discoveryRoutes);

// Routes
app.use('/api/agents', agentRoutes);
app.use('/api/agents', inboxRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/agents', outboxRoutes);
app.use('/api/keys', keysRoutes);
app.use('/api', inboxRoutes);  // For /api/messages/:id/status
app.use('/api', outboxWebhookRouter);  // For /api/webhooks/mailgun

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
      const ephemeralPurged = await inboxService.purgeExpiredEphemeralMessages();

      if (leasesReclaimed > 0 || messagesExpired > 0 || messagesDeleted > 0 || ephemeralPurged > 0) {
        logger.debug({
          leasesReclaimed,
          messagesExpired,
          messagesDeleted,
          ephemeralPurged
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

// Export app and lifecycle functions for testing and production use
export default app;
export { startBackgroundJobs, stopBackgroundJobs, logger, PORT };
