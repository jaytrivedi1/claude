import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from '../../_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { id } = req.query;
  const invoiceId = parseInt(id as string);

  if (isNaN(invoiceId)) {
    return res.status(400).json({ message: 'Invalid invoice ID' });
  }

  try {
    const sql = getDb();

    // Get invoice activities from activity_log table
    const activities = await sql`
      SELECT * FROM activity_log
      WHERE entity_type = 'invoice' AND entity_id = ${invoiceId}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    // Also get email sends from invoice_emails table if it exists
    let emailActivities: any[] = [];
    try {
      emailActivities = await sql`
        SELECT
          id,
          'email_sent' as action,
          created_at,
          recipient_email as details
        FROM invoice_emails
        WHERE invoice_id = ${invoiceId}
        ORDER BY created_at DESC
      `;
    } catch {
      // Table might not exist, ignore
    }

    // Combine and sort activities
    const allActivities = [
      ...activities.map((a: any) => ({
        id: a.id,
        action: a.action,
        createdAt: a.created_at,
        details: a.details,
        userId: a.user_id
      })),
      ...emailActivities.map((e: any) => ({
        id: `email-${e.id}`,
        action: e.action,
        createdAt: e.created_at,
        details: e.details
      }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.status(200).json(transformKeys(allActivities));
  } catch (error: any) {
    console.error('API Error:', error);
    // Return empty array if activity_log table doesn't exist
    if (error.message?.includes('does not exist')) {
      return res.status(200).json([]);
    }
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
