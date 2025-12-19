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
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  const invoiceId = parseInt(id as string);

  if (isNaN(invoiceId)) {
    return res.status(400).json({ message: 'Invalid invoice ID' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET - View invoice
    if (req.method === 'GET') {
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name,
               c.email as contact_email, c.address as contact_address
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId} AND t.type = 'invoice'
      `;

      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      const lineItems = await sql`
        SELECT li.*, p.name as product_name, st.name as sales_tax_name, st.rate as sales_tax_rate
        FROM line_items li
        LEFT JOIN products p ON li.product_id = p.id
        LEFT JOIN sales_taxes st ON li.sales_tax_id = st.id
        WHERE li.transaction_id = ${invoiceId}
        ORDER BY li.id
      `;

      const ledgerEntries = await sql`
        SELECT le.*, a.name as account_name, a.code as account_code
        FROM ledger_entries le
        LEFT JOIN accounts a ON le.account_id = a.id
        WHERE le.transaction_id = ${invoiceId}
        ORDER BY le.id
      `;

      return res.status(200).json({
        transaction: transformKeys(invoices[0]),
        lineItems: transformKeys(lineItems),
        ledgerEntries: transformKeys(ledgerEntries)
      });
    }

    // PATCH - Edit invoice
    if (req.method === 'PATCH') {
      const data = req.body;

      const existingInvoices = await sql`
        SELECT * FROM transactions WHERE id = ${invoiceId} AND type = 'invoice'
      `;

      if (existingInvoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      const existing = existingInvoices[0];

      // Calculate amounts if line items provided
      let newAmount = Number(existing.amount);
      let newSubTotal = Number(existing.sub_total) || newAmount;
      let newTaxAmount = Number(existing.tax_amount) || 0;
      let newBalance = Number(existing.balance);

      if (data.lineItems && Array.isArray(data.lineItems)) {
        newSubTotal = data.lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
        newTaxAmount = Number(data.taxAmount) || 0;
        newAmount = newSubTotal + newTaxAmount;

        if (existing.status !== 'paid') {
          const amountDiff = newAmount - Number(existing.amount);
          newBalance = Math.max(0, Number(existing.balance) + amountDiff);
        }
      }

      // Update invoice
      await sql`
        UPDATE transactions SET
          reference = ${data.reference ?? existing.reference},
          date = ${data.date ?? existing.date},
          due_date = ${data.dueDate ?? existing.due_date},
          contact_id = ${data.contactId ?? existing.contact_id},
          description = ${data.description ?? existing.description},
          memo = ${data.memo ?? existing.memo},
          status = ${data.status ?? existing.status},
          currency = ${data.currency ?? existing.currency},
          exchange_rate = ${data.exchangeRate ?? existing.exchange_rate},
          foreign_amount = ${data.foreignAmount ?? existing.foreign_amount},
          amount = ${newAmount},
          sub_total = ${newSubTotal},
          tax_amount = ${newTaxAmount},
          balance = ${newBalance},
          updated_at = NOW()
        WHERE id = ${invoiceId}
      `;

      // Update line items if provided
      if (data.lineItems && Array.isArray(data.lineItems)) {
        await sql`DELETE FROM line_items WHERE transaction_id = ${invoiceId}`;

        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id, account_id)
            VALUES (${invoiceId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null}, ${item.accountId || null})
          `;
        }

        // Update ledger entries
        await sql`DELETE FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

        const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
        const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;
        const taxPayableAccount = await sql`SELECT id FROM accounts WHERE code = '2100' LIMIT 1`;

        const invoiceDate = data.date || existing.date;
        const invoiceRef = data.reference || existing.reference || `INV-${invoiceId}`;

        if (arAccount.length > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${arAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef}`}, ${newAmount}, 0, ${invoiceDate})
          `;
        }

        if (revenueAccount.length > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${revenueAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef} - Revenue`}, 0, ${newSubTotal}, ${invoiceDate})
          `;
        }

        if (taxPayableAccount.length > 0 && newTaxAmount > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${taxPayableAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef} - Tax`}, 0, ${newTaxAmount}, ${invoiceDate})
          `;
        }
      }

      // Return updated invoice
      const updated = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId}
      `;

      const updatedLineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;

      return res.status(200).json({
        success: true,
        transaction: transformKeys(updated[0]),
        lineItems: transformKeys(updatedLineItems)
      });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
