import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from '../_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  const { id } = req.query;
  const invoiceId = parseInt(id as string);

  if (isNaN(invoiceId)) {
    return res.status(400).json({ message: 'Invalid invoice ID' });
  }

  try {
    const sql = getDb();

    // GET - Fetch invoice details
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

    // PATCH - Update invoice
    if (req.method === 'PATCH') {
      const data = req.body;

      // Fetch existing invoice
      const existingInvoices = await sql`
        SELECT * FROM transactions WHERE id = ${invoiceId} AND type = 'invoice'
      `;

      if (existingInvoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      const existingInvoice = existingInvoices[0];

      // Calculate new amounts if line items provided
      let newAmount = Number(existingInvoice.amount);
      let newSubTotal = Number(existingInvoice.sub_total) || newAmount;
      let newTaxAmount = Number(existingInvoice.tax_amount) || 0;
      let newBalance = Number(existingInvoice.balance);

      if (data.lineItems && Array.isArray(data.lineItems)) {
        newSubTotal = data.lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
        newTaxAmount = Number(data.taxAmount) || 0;
        newAmount = newSubTotal + newTaxAmount;

        // Adjust balance if invoice not fully paid
        if (existingInvoice.status !== 'paid') {
          const amountDiff = newAmount - Number(existingInvoice.amount);
          newBalance = Math.max(0, Number(existingInvoice.balance) + amountDiff);
        }
      }

      // Update the invoice
      await sql`
        UPDATE transactions SET
          reference = ${data.reference !== undefined ? data.reference : existingInvoice.reference},
          date = ${data.date !== undefined ? data.date : existingInvoice.date},
          due_date = ${data.dueDate !== undefined ? data.dueDate : existingInvoice.due_date},
          contact_id = ${data.contactId !== undefined ? data.contactId : existingInvoice.contact_id},
          description = ${data.description !== undefined ? data.description : existingInvoice.description},
          memo = ${data.memo !== undefined ? data.memo : existingInvoice.memo},
          status = ${data.status !== undefined ? data.status : existingInvoice.status},
          currency = ${data.currency !== undefined ? data.currency : existingInvoice.currency},
          exchange_rate = ${data.exchangeRate !== undefined ? data.exchangeRate : existingInvoice.exchange_rate},
          foreign_amount = ${data.foreignAmount !== undefined ? data.foreignAmount : existingInvoice.foreign_amount},
          amount = ${newAmount},
          sub_total = ${newSubTotal},
          tax_amount = ${newTaxAmount},
          balance = ${newBalance},
          updated_at = NOW()
        WHERE id = ${invoiceId}
      `;

      // Update line items if provided
      if (data.lineItems && Array.isArray(data.lineItems)) {
        // Delete existing line items
        await sql`DELETE FROM line_items WHERE transaction_id = ${invoiceId}`;

        // Insert new line items
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id, account_id)
            VALUES (${invoiceId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null}, ${item.accountId || null})
          `;
        }

        // Update ledger entries
        await sql`DELETE FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

        // Get account IDs for ledger entries
        const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
        const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;
        const taxPayableAccount = await sql`SELECT id FROM accounts WHERE code = '2100' LIMIT 1`;

        const invoiceDate = data.date || existingInvoice.date;
        const invoiceRef = data.reference || existingInvoice.reference || `INV-${invoiceId}`;

        // Debit Accounts Receivable
        if (arAccount.length > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${arAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef}`}, ${newAmount}, 0, ${invoiceDate})
          `;
        }

        // Credit Revenue
        if (revenueAccount.length > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${revenueAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef} - Revenue`}, 0, ${newSubTotal}, ${invoiceDate})
          `;
        }

        // Credit Tax Payable (if applicable)
        if (taxPayableAccount.length > 0 && newTaxAmount > 0) {
          await sql`
            INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
            VALUES (${taxPayableAccount[0].id}, ${invoiceId}, ${`Invoice ${invoiceRef} - Tax`}, 0, ${newTaxAmount}, ${invoiceDate})
          `;
        }
      }

      // Fetch updated invoice
      const updatedInvoice = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId}
      `;

      const updatedLineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;

      return res.status(200).json({
        success: true,
        transaction: transformKeys(updatedInvoice[0]),
        lineItems: transformKeys(updatedLineItems)
      });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
