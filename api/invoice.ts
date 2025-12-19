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
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id as string;
  if (!id) {
    return res.status(400).json({ message: 'Invoice ID required' });
  }

  const invoiceId = parseInt(id);
  if (isNaN(invoiceId)) {
    return res.status(400).json({ message: 'Invalid invoice ID' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId} AND t.type = 'invoice'
      `;

      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;
      const ledgerEntries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

      return res.status(200).json({
        transaction: transformKeys(invoices[0]),
        lineItems: transformKeys(lineItems),
        ledgerEntries: transformKeys(ledgerEntries)
      });
    }

    if (req.method === 'PATCH') {
      const data = req.body;

      // Calculate amounts
      let invoiceAmount = data.totalAmount || data.amount;
      if (!invoiceAmount && data.lineItems && Array.isArray(data.lineItems)) {
        invoiceAmount = data.lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
        invoiceAmount += Number(data.taxAmount) || 0;
      }
      invoiceAmount = Number(invoiceAmount) || 0;
      const subTotal = Number(data.subTotal) || invoiceAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      // Get existing invoice to calculate balance difference
      const existing = await sql`SELECT amount, balance FROM transactions WHERE id = ${invoiceId}`;
      if (existing.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      const oldAmount = Number(existing[0].amount) || 0;
      const oldBalance = Number(existing[0].balance) || 0;
      const paidAmount = oldAmount - oldBalance;
      const newBalance = Math.max(0, invoiceAmount - paidAmount);

      // Update transaction
      await sql`
        UPDATE transactions
        SET reference = ${data.reference},
            date = ${data.date},
            due_date = ${data.dueDate},
            contact_id = ${data.contactId},
            amount = ${invoiceAmount},
            balance = ${newBalance},
            currency = ${data.currency || 'CAD'},
            memo = ${data.memo || data.description || ''},
            sub_total = ${subTotal},
            tax_amount = ${taxAmount}
        WHERE id = ${invoiceId}
      `;

      // Update line items
      await sql`DELETE FROM line_items WHERE transaction_id = ${invoiceId}`;
      if (data.lineItems && Array.isArray(data.lineItems)) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id)
            VALUES (${invoiceId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null})
          `;
        }
      }

      // Update ledger entries
      await sql`DELETE FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

      const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
      const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;

      if (arAccount.length > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${arAccount[0].id}, ${invoiceId}, ${`Invoice ${data.reference}`}, ${invoiceAmount}, 0, ${data.date})
        `;
      }

      if (revenueAccount.length > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${revenueAccount[0].id}, ${invoiceId}, ${`Invoice ${data.reference} - Revenue`}, 0, ${subTotal}, ${data.date})
        `;
      }

      return res.status(200).json({ success: true, id: invoiceId });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('[API] Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
