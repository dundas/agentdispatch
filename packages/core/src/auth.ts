/**
 * Authentication Middleware
 * Bearer token validation for API requests
 */

import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const logger = pino({ name: 'auth' });

// For MVP, we'll use a simple API key validation
// In production, this should validate against database or JWT
const VALID_API_KEY = process.env.API_KEY || 'dev-key-admp-local';

export interface AuthenticatedRequest extends Request {
  agentId?: string;
}

/**
 * Middleware to validate Bearer token authentication
 */
export function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'Missing Authorization header',
    });
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer') {
    res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid authentication scheme. Use Bearer token.',
    });
    return;
  }

  if (!token) {
    res.status(401).json({
      error: 'unauthorized',
      message: 'Missing API key in Bearer token',
    });
    return;
  }

  // Simple validation for MVP
  if (token !== VALID_API_KEY) {
    logger.warn({ token: token.substring(0, 8) + '...' }, 'Invalid API key');
    res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid API key',
    });
    return;
  }

  // For MVP, we don't extract agentId from token
  // In production, decode JWT or look up in database
  next();
}

/**
 * Optional middleware - allows unauthenticated access
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    // If auth is provided, validate it
    authenticateRequest(req, res, next);
  } else {
    // Otherwise, continue without auth
    next();
  }
}
