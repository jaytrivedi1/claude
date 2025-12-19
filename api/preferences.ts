import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      const preferences = await sql`
        SELECT * FROM preferences LIMIT 1
      `;

      if (preferences.length === 0) {
        // Return default preferences
        return res.status(200).json({
          homeCurrency: 'CAD',
          dateFormat: 'yyyy-MM-dd',
          fiscalYearStart: 1,
          defaultPaymentTerms: 'net30'
        });
      }

      return res.status(200).json(transformKeys(preferences[0]));
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    // Return defaults if table doesn't exist
    if (error.message?.includes('does not exist')) {
      return res.status(200).json({
        homeCurrency: 'CAD',
        dateFormat: 'yyyy-MM-dd',
        fiscalYearStart: 1,
        defaultPaymentTerms: 'net30'
      });
    }
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
