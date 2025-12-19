import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      const products = await sql`
        SELECT p.*, a.name as account_name, st.name as tax_name
        FROM products p
        LEFT JOIN accounts a ON p.account_id = a.id
        LEFT JOIN sales_taxes st ON p.sales_tax_id = st.id
        WHERE p.is_active = true
        ORDER BY p.name ASC
      `;
      return res.status(200).json(transformKeys(products));
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
