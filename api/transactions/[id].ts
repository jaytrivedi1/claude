import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function transformKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(transformKeys);
  if (obj instanceof Date) return obj.toISOString();
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      acc[toCamelCase(key)] = value instanceof Date ? value.toISOString() : transformKeys(value);
      return acc;
    }, {} as any);
  }
  return obj;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Get ID from query params
  const { id } = req.query;
  const transactionId = parseInt(id as string);

  console.log('[API] Transaction request:', { method: req.method, id, transactionId });

  if (isNaN(transactionId)) {
    return res.status(400).json({ message: 'Invalid transaction ID', received: id });
  }

  if (!process.env.DATABASE_URL) {
    console.error('[API] DATABASE_URL not configured');
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    if (req.method === 'GET') {
      // Simple query first - just get the transaction
      const transactions = await sql`
        SELECT * FROM transactions WHERE id = ${transactionId}
      `;

      console.log('[API] Transaction query result:', transactions.length, 'rows');

      if (transactions.length === 0) {
        return res.status(404).json({ message: 'Transaction not found', id: transactionId });
      }

      // Get contact info separately
      let contactName = null;
      if (transactions[0].contact_id) {
        const contacts = await sql`
          SELECT name, display_name, email, address FROM contacts WHERE id = ${transactions[0].contact_id}
        `;
        if (contacts.length > 0) {
          contactName = contacts[0].name;
          transactions[0].contact_name = contacts[0].name;
          transactions[0].contact_display_name = contacts[0].display_name;
          transactions[0].contact_email = contacts[0].email;
          transactions[0].contact_address = contacts[0].address;
        }
      }

      // Get line items
      const lineItems = await sql`
        SELECT * FROM line_items WHERE transaction_id = ${transactionId} ORDER BY id
      `;

      console.log('[API] Line items:', lineItems.length, 'rows');

      // Get ledger entries
      const ledgerEntries = await sql`
        SELECT * FROM ledger_entries WHERE transaction_id = ${transactionId} ORDER BY id
      `;

      console.log('[API] Ledger entries:', ledgerEntries.length, 'rows');

      return res.status(200).json({
        transaction: transformKeys(transactions[0]),
        lineItems: transformKeys(lineItems),
        ledgerEntries: transformKeys(ledgerEntries)
      });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM line_items WHERE transaction_id = ${transactionId}`;
      await sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`;
      await sql`DELETE FROM payment_applications WHERE payment_id = ${transactionId} OR invoice_id = ${transactionId}`;
      await sql`DELETE FROM transactions WHERE id = ${transactionId}`;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('[API] Error:', error.message, error.stack);
    return res.status(500).json({
      message: 'Server error',
      error: error.message,
      hint: 'Check DATABASE_URL and database tables'
    });
  }
}
