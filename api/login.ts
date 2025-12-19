import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';
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
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const sql = getDb();
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Query user
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

    return res.status(200).json(transformKeys({
      ...userWithoutPassword,
      companies: userCompanies
    }));
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
