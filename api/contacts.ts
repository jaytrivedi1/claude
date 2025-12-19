import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      const contacts = await sql`
        SELECT * FROM contacts
        WHERE is_active = true
        ORDER BY name ASC
      `;
      return res.status(200).json(transformKeys(contacts));
    }

    if (req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO contacts (name, display_name, email, phone, address, type, is_active)
        VALUES (
          ${data.name},
          ${data.displayName || data.name},
          ${data.email || null},
          ${data.phone || null},
          ${data.address || null},
          ${data.type || 'customer'},
          true
        )
        RETURNING *
      `;
      return res.status(201).json(transformKeys(result[0]));
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
