import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      const { type, status } = req.query;

      let transactions;
      if (type) {
        transactions = await sql`
          SELECT t.*, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE t.type = ${type}
          ORDER BY t.date DESC, t.id DESC
        `;
      } else {
        transactions = await sql`
          SELECT t.*, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          ORDER BY t.date DESC, t.id DESC
        `;
      }

      return res.status(200).json(transformKeys(transactions));
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
