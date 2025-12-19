import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Get income (invoices)
    const incomeResult = await sql`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'invoice'
    `;
    // Get expenses
    const expenseResult = await sql`
      SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'
    `;

    const income = Number(incomeResult[0]?.total) || 0;
    const expenses = Number(expenseResult[0]?.total) || 0;
    const netProfit = income - expenses;

    // Get unpaid invoices
    const unpaidInvoices = await sql`
      SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as amount
      FROM transactions WHERE type = 'invoice' AND status IN ('open', 'partial')
    `;

    // Get paid invoices
    const paidInvoices = await sql`
      SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as amount
      FROM transactions WHERE type = 'invoice' AND status = 'paid'
    `;

    // Get bank accounts
    const bankAccounts = await sql`
      SELECT name, balance FROM accounts WHERE type = 'bank' AND is_active = true
    `;

    const totalBankBalance = bankAccounts.reduce((sum: number, acc: any) => sum + (Number(acc.balance) || 0), 0);

    return res.status(200).json({
      profitLoss: {
        netProfit,
        percentageChange: 0,
        income,
        expenses
      },
      expensesByCategory: [],
      invoices: {
        unpaid: { count: Number(unpaidInvoices[0]?.count) || 0, amount: Number(unpaidInvoices[0]?.amount) || 0 },
        paid: { count: Number(paidInvoices[0]?.count) || 0, amount: Number(paidInvoices[0]?.amount) || 0 },
        overdue: { count: 0, amount: 0 },
        deposited: { count: 0, amount: 0 }
      },
      bankAccounts: {
        total: totalBankBalance,
        accounts: bankAccounts.map((acc: any) => ({
          name: acc.name,
          balance: Number(acc.balance) || 0,
          updated: new Date().toISOString()
        }))
      },
      sales: [],
      accountsReceivable: {
        total: Number(unpaidInvoices[0]?.amount) || 0,
        current: Number(unpaidInvoices[0]?.amount) || 0,
        days30: 0,
        days60: 0,
        days90Plus: 0
      }
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
