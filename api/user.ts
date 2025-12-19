import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions, getUserId } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const sql = getDb();

    const users = await sql`
      SELECT id, username, email, role, is_active, first_name, last_name, created_at
      FROM users WHERE id = ${userId} LIMIT 1
    `;

    if (users.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Get user's companies
    const companies = await sql`
      SELECT c.* FROM user_companies uc
      JOIN companies c ON uc.company_id = c.id
      WHERE uc.user_id = ${userId}
    `;

    return res.status(200).json(transformKeys({
      ...users[0],
      companies
    }));
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
