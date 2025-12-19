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

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Check if we have an ID (single transaction) or not (list)
    const id = req.query.id as string;

    if (id) {
      // GET single transaction
      const transactionId = parseInt(id);
      if (isNaN(transactionId)) {
        return res.status(400).json({ message: 'Invalid transaction ID' });
      }

      if (req.method === 'GET') {
        const transactions = await sql`SELECT * FROM transactions WHERE id = ${transactionId}`;

        if (transactions.length === 0) {
          return res.status(404).json({ message: 'Transaction not found' });
        }

        // Get contact info
        if (transactions[0].contact_id) {
          const contacts = await sql`SELECT name, email, address FROM contacts WHERE id = ${transactions[0].contact_id}`;
          if (contacts.length > 0) {
            transactions[0].contact_name = contacts[0].name;
            transactions[0].contact_email = contacts[0].email;
            transactions[0].contact_address = contacts[0].address;
          }
        }

        const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${transactionId} ORDER BY id`;
        const ledgerEntries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${transactionId} ORDER BY id`;

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
    } else {
      // GET list of transactions
      if (req.method === 'GET') {
        const transactions = await sql`
          SELECT t.*, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          ORDER BY t.date DESC
          LIMIT 100
        `;
        return res.status(200).json(transformKeys(transactions));
      }
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('[API] Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
