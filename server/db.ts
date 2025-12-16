import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from "@shared/schema";

// Only use WebSocket in non-serverless environments
if (typeof process !== 'undefined' && process.env.VERCEL !== '1') {
  try {
    const ws = await import('ws');
    neonConfig.webSocketConstructor = ws.default;
  } catch {
    // WebSocket not available, using HTTP mode (serverless)
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
