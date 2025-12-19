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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET - List invoices
    if (req.method === 'GET') {
      const invoices = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'invoice'
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(invoices));
    }

    // POST - Create invoice
    if (req.method === 'POST') {
      const data = req.body;

      // Calculate amount from line items if not provided
      let invoiceAmount = data.totalAmount || data.amount;
      if (!invoiceAmount && data.lineItems && Array.isArray(data.lineItems)) {
        const lineItemsTotal = data.lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
        const taxAmount = Number(data.taxAmount) || 0;
        invoiceAmount = lineItemsTotal + taxAmount;
      }
      invoiceAmount = Number(invoiceAmount) || 0;

      const subTotal = Number(data.subTotal) || invoiceAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      console.log('[API] Creating invoice:', { amount: invoiceAmount, subTotal, taxAmount });

      const result = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, balance, currency, status, memo, sub_total, tax_amount)
        VALUES ('invoice', ${data.reference}, ${data.date}, ${data.dueDate}, ${data.contactId}, ${invoiceAmount}, ${invoiceAmount}, ${data.currency || 'CAD'}, 'open', ${data.memo || data.description || ''}, ${subTotal}, ${taxAmount})
        RETURNING id
      `;

      const transactionId = result[0].id;

      // Insert line items
      if (data.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id)
            VALUES (${transactionId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null})
          `;
        }
      }

      // Create ledger entries
      const invoiceRef = data.reference || `INV-${transactionId}`;
      const invoiceDate = data.date;

      // Get or create accounts
      let arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
      if (arAccount.length === 0) {
        arAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES ('1100', 'Accounts Receivable', 'accounts_receivable', 'Money owed by customers', 0, 'CAD', true)
          RETURNING id
        `;
      }

      let revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;
      if (revenueAccount.length === 0) {
        revenueAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES ('4000', 'Service Revenue', 'income', 'Revenue from services', 0, 'CAD', true)
          RETURNING id
        `;
      }

      // Debit AR
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${arAccount[0].id}, ${transactionId}, ${`Invoice ${invoiceRef}`}, ${invoiceAmount}, 0, ${invoiceDate})
      `;

      // Credit Revenue
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${revenueAccount[0].id}, ${transactionId}, ${`Invoice ${invoiceRef} - Revenue`}, 0, ${subTotal}, ${invoiceDate})
      `;

      // Update account balances
      await sql`UPDATE accounts SET balance = balance + ${invoiceAmount} WHERE id = ${arAccount[0].id}`;
      await sql`UPDATE accounts SET balance = balance + ${subTotal} WHERE id = ${revenueAccount[0].id}`;

      // Handle tax if applicable
      if (taxAmount > 0) {
        let taxAccount = await sql`SELECT id FROM accounts WHERE code = '2100' LIMIT 1`;
        if (taxAccount.length === 0) {
          taxAccount = await sql`
            INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
            VALUES ('2100', 'Sales Tax Payable', 'other_current_liabilities', 'Tax collected', 0, 'CAD', true)
            RETURNING id
          `;
        }
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxAccount[0].id}, ${transactionId}, ${`Invoice ${invoiceRef} - Tax`}, 0, ${taxAmount}, ${invoiceDate})
        `;
        await sql`UPDATE accounts SET balance = balance + ${taxAmount} WHERE id = ${taxAccount[0].id}`;
      }

      return res.status(201).json({ id: transactionId, success: true });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('[API] Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
