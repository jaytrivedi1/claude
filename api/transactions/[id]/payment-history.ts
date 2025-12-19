import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, transformKeys, setCorsHeaders, handleOptions } from '../../_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { id } = req.query;
  const transactionId = parseInt(id as string);

  if (isNaN(transactionId)) {
    return res.status(400).json({ message: 'Invalid transaction ID' });
  }

  try {
    const sql = getDb();

    // Get the transaction
    const transactions = await sql`
      SELECT * FROM transactions WHERE id = ${transactionId}
    `;

    if (transactions.length === 0) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const transaction = transactions[0];

    // Get payment applications for this invoice
    const paymentApplications = await sql`
      SELECT pa.*, t.reference as payment_reference, t.date as payment_date, t.type as payment_type
      FROM payment_applications pa
      JOIN transactions t ON pa.payment_id = t.id
      WHERE pa.invoice_id = ${transactionId}
      ORDER BY t.date DESC
    `;

    // Get ledger entries that are payments (credits to AR for this transaction)
    const paymentLedgerEntries = await sql`
      SELECT le.*, t.reference, t.date, t.type
      FROM ledger_entries le
      JOIN transactions t ON le.transaction_id = t.id
      WHERE le.description LIKE ${`%${transaction.reference || transactionId}%`}
        AND le.credit > 0
        AND t.type IN ('payment', 'customer_payment', 'credit_note')
      ORDER BY le.date DESC
    `;

    // Calculate totals
    let totalPaid = 0;
    const payments: any[] = [];

    // Add payment applications
    for (const pa of paymentApplications) {
      totalPaid += Number(pa.amount_applied) || 0;
      payments.push({
        id: pa.payment_id,
        date: pa.payment_date,
        reference: pa.payment_reference,
        type: pa.payment_type,
        amount: Number(pa.amount_applied) || 0,
        source: 'payment_application'
      });
    }

    // Add ledger-based payments (if not already counted)
    for (const le of paymentLedgerEntries) {
      const alreadyCounted = payments.some(p => p.id === le.transaction_id);
      if (!alreadyCounted) {
        totalPaid += Number(le.credit) || 0;
        payments.push({
          id: le.transaction_id,
          date: le.date,
          reference: le.reference,
          type: le.type,
          amount: Number(le.credit) || 0,
          source: 'ledger_entry'
        });
      }
    }

    const total = Number(transaction.amount) || 0;
    const balance = Number(transaction.balance) ?? (total - totalPaid);

    return res.status(200).json({
      payments: transformKeys(payments),
      summary: {
        total,
        totalPaid,
        balance: Math.max(0, balance),
        status: transaction.status
      }
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
