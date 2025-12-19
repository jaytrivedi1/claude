import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      // Get all invoices with contact info
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'invoice'
        ORDER BY t.date DESC, t.id DESC
      `;
      return res.status(200).json(transformKeys(invoices));
    }

    if (req.method === 'POST') {
      const data = req.body;

      // Calculate totals
      const lineItems = data.lineItems || [];
      const subTotal = lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
      const taxAmount = Number(data.taxAmount) || 0;
      const totalAmount = subTotal + taxAmount;

      // Create the invoice
      const result = await sql`
        INSERT INTO transactions (
          type, reference, date, due_date, contact_id, description, memo,
          amount, sub_total, tax_amount, balance, status, currency, exchange_rate, foreign_amount
        ) VALUES (
          'invoice',
          ${data.reference},
          ${data.date},
          ${data.dueDate || null},
          ${data.contactId},
          ${data.description || ''},
          ${data.memo || ''},
          ${totalAmount},
          ${subTotal},
          ${taxAmount},
          ${totalAmount},
          ${data.status || 'open'},
          ${data.currency || null},
          ${data.exchangeRate || null},
          ${data.foreignAmount || null}
        )
        RETURNING *
      `;

      const invoiceId = result[0].id;

      // Create line items
      for (const item of lineItems) {
        await sql`
          INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id, account_id)
          VALUES (${invoiceId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null}, ${item.accountId || null})
        `;
      }

      // Create ledger entries
      const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
      const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;
      const taxPayableAccount = await sql`SELECT id FROM accounts WHERE code = '2100' LIMIT 1`;

      if (arAccount.length > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${arAccount[0].id}, ${invoiceId}, ${`Invoice ${data.reference}`}, ${totalAmount}, 0, ${data.date})
        `;
      }

      if (revenueAccount.length > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${revenueAccount[0].id}, ${invoiceId}, ${`Invoice ${data.reference} - Revenue`}, 0, ${subTotal}, ${data.date})
        `;
      }

      if (taxPayableAccount.length > 0 && taxAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxPayableAccount[0].id}, ${invoiceId}, ${`Invoice ${data.reference} - Tax`}, 0, ${taxAmount}, ${data.date})
        `;
      }

      return res.status(201).json({
        id: invoiceId,
        success: true,
        transaction: transformKeys(result[0])
      });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
