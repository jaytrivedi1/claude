import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions, getUserId } from '../_shared';

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

    // Get first company for this user
    const companies = await sql`
      SELECT c.* FROM user_companies uc
      JOIN companies c ON uc.company_id = c.id
      WHERE uc.user_id = ${userId}
      ORDER BY c.id ASC
      LIMIT 1
    `;

    if (companies.length === 0) {
      return res.status(404).json({ message: 'No company found' });
    }

    return res.status(200).json(transformKeys(companies[0]));
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
