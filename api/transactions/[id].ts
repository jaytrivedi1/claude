import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from '../_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  const { id } = req.query;
  const transactionId = parseInt(id as string);

  if (isNaN(transactionId)) {
    return res.status(400).json({ message: 'Invalid transaction ID' });
  }

  try {
    const sql = getDb();

    if (req.method === 'GET') {
      // Get transaction with contact info
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

      // Get line items
      const lineItems = await sql`
        SELECT li.*, p.name as product_name, st.name as sales_tax_name, st.rate as sales_tax_rate
        FROM line_items li
        LEFT JOIN products p ON li.product_id = p.id
        LEFT JOIN sales_taxes st ON li.sales_tax_id = st.id
        WHERE li.transaction_id = ${transactionId}
        ORDER BY li.id
      `;

      // Get ledger entries
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
      // Delete related records first
      await sql`DELETE FROM line_items WHERE transaction_id = ${transactionId}`;
      await sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`;
      await sql`DELETE FROM payment_applications WHERE payment_id = ${transactionId} OR invoice_id = ${transactionId}`;
      await sql`DELETE FROM transactions WHERE id = ${transactionId}`;

      return res.status(200).json({ success: true, message: 'Transaction deleted' });
    }

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
