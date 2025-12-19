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

  const { id } = req.query;
  const transactionId = parseInt(id as string);

  if (isNaN(transactionId)) {
    return res.status(400).json({ message: 'Invalid transaction ID' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const transactions = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name,
               c.email as contact_email, c.address as contact_address
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${transactionId}
      `;

      if (transactions.length === 0) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      const lineItems = await sql`
        SELECT li.*, p.name as product_name, st.name as sales_tax_name, st.rate as sales_tax_rate
        FROM line_items li
        LEFT JOIN products p ON li.product_id = p.id
        LEFT JOIN sales_taxes st ON li.sales_tax_id = st.id
        WHERE li.transaction_id = ${transactionId}
        ORDER BY li.id
      `;

      const ledgerEntries = await sql`
        SELECT le.*, a.name as account_name, a.code as account_code
        FROM ledger_entries le
        LEFT JOIN accounts a ON le.account_id = a.id
        WHERE le.transaction_id = ${transactionId}
        ORDER BY le.id
      `;

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
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
