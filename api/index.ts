import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
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

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

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

      // Query user directly with SQL
      const users = await sql`
        SELECT * FROM users
        WHERE email = ${username} OR username = ${username}
        LIMIT 1
      `;

      if (users.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const user = users[0];

      if (!user.is_active) {
        return res.status(401).json({ message: 'Account is disabled' });
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      // Get user's companies
      const userCompanies = await sql`
        SELECT c.* FROM user_companies uc
        JOIN companies c ON uc.company_id = c.id
        WHERE uc.user_id = ${user.id}
      `;

      // Don't send password to client
      const { password: _, ...userWithoutPassword } = user;

      return res.status(200).json({
        ...userWithoutPassword,
        companies: userCompanies
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
