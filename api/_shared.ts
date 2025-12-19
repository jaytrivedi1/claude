// Shared utilities for API handlers
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';

// Convert snake_case to camelCase
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Transform object keys from snake_case to camelCase and handle dates
export function transformKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(transformKeys);
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      if (value instanceof Date) {
        acc[toCamelCase(key)] = value.toISOString();
      } else {
        acc[toCamelCase(key)] = transformKeys(value);
      }
      return acc;
    }, {} as any);
  }
  return obj;
}

// Get database connection
export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured');
  }
  return neon(process.env.DATABASE_URL);
}

// Set CORS headers
export function setCorsHeaders(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');
}

// Handle OPTIONS request
export function handleOptions(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// Get user ID from request
export function getUserId(req: VercelRequest): string | undefined {
  return req.headers['x-user-id'] as string;
}
