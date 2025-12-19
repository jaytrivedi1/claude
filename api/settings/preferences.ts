import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Return default preferences
    return res.status(200).json({
      homeCurrency: 'CAD',
      dateFormat: 'MM/dd/yyyy',
      timezone: 'America/Toronto'
    });
  }

  return res.status(405).json({ message: 'Method not allowed' });
}
