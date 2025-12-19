import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
}
