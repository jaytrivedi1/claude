import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, setCorsHeaders, handleOptions } from '../_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const sql = getDb();

    // Get the highest invoice number
    const result = await sql`
      SELECT reference FROM transactions
      WHERE type = 'invoice' AND reference ~ '^[0-9]+$'
      ORDER BY CAST(reference AS INTEGER) DESC
      LIMIT 1
    `;

    let nextNumber = 1001;
    if (result.length > 0 && result[0].reference) {
      const currentNumber = parseInt(result[0].reference, 10);
      if (!isNaN(currentNumber)) {
        nextNumber = currentNumber + 1;
      }
    }

    return res.status(200).json({ nextNumber: nextNumber.toString() });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
