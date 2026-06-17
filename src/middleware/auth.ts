import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.path === '/health') {
    next();
    return;
  }

  const apiKey = req.headers['x-api-key'] as string;

  if (!config.server.apiKey) {
    // No API key configured, skip auth (dev mode)
    next();
    return;
  }

  if (!apiKey || apiKey !== config.server.apiKey) {
    res.status(401).json({ code: -1, message: '未授权：API Key 无效' });
    return;
  }

  next();
}
