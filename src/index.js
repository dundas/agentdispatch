/**
 * ADMP Server Entry Point
 * Starts the server with background jobs and graceful shutdown handling
 */

import app, { startBackgroundJobs, stopBackgroundJobs, logger, PORT } from './server.js';

// Start server
const server = app.listen(PORT, () => {
  logger.info(`ADMP server listening on port ${PORT}`);
  logger.info({
    env: process.env.NODE_ENV || 'development',
    heartbeat_interval: process.env.HEARTBEAT_INTERVAL_MS || 60000,
    heartbeat_timeout: process.env.HEARTBEAT_TIMEOUT_MS || 300000,
    message_ttl: process.env.MESSAGE_TTL_SEC || 86400,
    cleanup_interval: parseInt(process.env.CLEANUP_INTERVAL_MS) || 60000,
    api_docs: `http://localhost:${PORT}/docs`,
    openapi_spec: `http://localhost:${PORT}/openapi.json`
  }, 'Server configuration');

  startBackgroundJobs();
});

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  stopBackgroundJobs();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
