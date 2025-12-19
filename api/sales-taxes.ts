import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      const taxes = await sql`
        SELECT * FROM sales_taxes
        WHERE is_active = true
        ORDER BY name ASC
      `;
      return res.status(200).json(transformKeys(taxes));
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
