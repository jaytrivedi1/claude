import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../server/db';
import { usersSchema, userCompaniesSchema, companiesSchema } from '../shared/schema';
import { eq, or } from 'drizzle-orm';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  try {
    const [hash, salt] = hashedPassword.split('.');
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    const hashBuffer = Buffer.from(hash, 'hex');
    return timingSafeEqual(derivedKey, hashBuffer);
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = req.url?.replace('/api', '') || '';

  try {
    // Health check
    if (path === '/health' || path === '/') {
      return res.status(200).json({ status: 'ok', path: req.url });
    }

    // Login
    if (path === '/login' && req.method === 'POST') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
      }

      const users = await db.select().from(usersSchema).where(
        or(eq(usersSchema.email, username), eq(usersSchema.username, username))
      );

      if (users.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const user = users[0];

      if (!user.isActive) {
        return res.status(401).json({ message: 'Account is disabled' });
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      // Get user's companies
      const userCompanies = await db.select({
        company: companiesSchema
      })
      .from(userCompaniesSchema)
      .innerJoin(companiesSchema, eq(userCompaniesSchema.companyId, companiesSchema.id))
      .where(eq(userCompaniesSchema.userId, user.id));

      const { password: _, ...userWithoutPassword } = user;

      return res.status(200).json({
        ...userWithoutPassword,
        companies: userCompanies.map(uc => uc.company)
      });
    }

    // Get user (stub - would need session management)
    if (path === '/user' && req.method === 'GET') {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    return res.status(404).json({ message: 'Not found', path });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({
      message: 'Server error',
      error: error.message
    });
  }
}
