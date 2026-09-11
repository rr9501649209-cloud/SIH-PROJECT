// backend/middleware/auth.ts

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Please add JWT_SECRET to your environment variables.'
  );
}

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

export function signSession(id: string, role: string) {
  return jwt.sign(
    {
      sub: id,
      role: role,
    },
    JWT_SECRET,
    {
      expiresIn: '12h',
    }
  );
}

export function authenticate(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization || '';

  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      error: 'Missing bearer token',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      sub: string;
      role: string;
    };

    if (!decoded.sub || !decoded.role) {
      return res.status(401).json({
        error: 'Invalid session payload',
      });
    }

    req.user = {
      id: decoded.sub,
      role: decoded.role,
    };

    next();
  } catch {
    return res.status(401).json({
      error: 'Invalid or expired session',
    });
  }
}

export function requireRole(...roles: string[]) {
  return (
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `This action requires one of: ${roles.join(', ')}`,
      });
    }

    next();
  };
}