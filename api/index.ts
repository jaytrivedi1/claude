import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// Convert snake_case to camelCase
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Transform object keys from snake_case to camelCase and handle dates
function transformKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(transformKeys);
  }
  // Convert Date objects to ISO strings
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      // Handle Date objects
      if (value instanceof Date) {
        acc[toCamelCase(key)] = value.toISOString();
      } else {
        acc[toCamelCase(key)] = transformKeys(value);
      }
      return acc;
    }, {} as any);
  }
  return obj;
}

async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  try {
    const [hash, salt] = hashedPassword.split('.');
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    const hashBuffer = Buffer.from(hash, 'hex');
    return timingSafeEqual(derivedKey, hashBuffer);
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the path - handle various formats
  const url = req.url || '';
  const path = url.split('?')[0]; // Remove query string
  const userId = req.headers['x-user-id'] as string;

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Health check
    if (path === '/api' || path === '/api/' || path === '/api/health') {
      return res.status(200).json({ status: 'ok', url: req.url, method: req.method });
    }

    // Login - match /api/login
    if ((path === '/api/login' || path.endsWith('/login')) && req.method === 'POST') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
      }

      // Query user directly with SQL
      const users = await sql`
        SELECT * FROM users
        WHERE email = ${username} OR username = ${username}
        LIMIT 1
      `;

      if (users.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const user = users[0];

      if (!user.is_active) {
        return res.status(401).json({ message: 'Account is disabled' });
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      // Get user's companies
      const userCompanies = await sql`
        SELECT c.* FROM user_companies uc
        JOIN companies c ON uc.company_id = c.id
        WHERE uc.user_id = ${user.id}
      `;

      // Don't send password to client
      const { password: _, ...userWithoutPassword } = user;

      return res.status(200).json(transformKeys({
        ...userWithoutPassword,
        companies: userCompanies
      }));
    }

    // Get user
    if ((path === '/api/user' || path.endsWith('/user')) && req.method === 'GET') {
      if (!userId) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (users.length === 0) {
        return res.status(401).json({ message: 'User not found' });
      }
      const { password: _, ...userWithoutPassword } = users[0];
      return res.status(200).json(transformKeys(userWithoutPassword));
    }

    // Get companies
    if ((path === '/api/companies' || path.endsWith('/companies')) && req.method === 'GET') {
      if (!userId) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const companies = await sql`
        SELECT c.* FROM user_companies uc
        JOIN companies c ON uc.company_id = c.id
        WHERE uc.user_id = ${userId}
      `;
      return res.status(200).json(transformKeys(companies));
    }

    // Get default company
    if ((path === '/api/companies/default' || path.endsWith('/companies/default')) && req.method === 'GET') {
      if (!userId) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      // Get first company for this user
      const companies = await sql`
        SELECT c.* FROM user_companies uc
        JOIN companies c ON uc.company_id = c.id
        WHERE uc.user_id = ${userId}
        ORDER BY c.id ASC
        LIMIT 1
      `;
      if (companies.length === 0) {
        return res.status(404).json({ message: 'No company found' });
      }
      return res.status(200).json(transformKeys(companies[0]));
    }

    // Dashboard metrics
    if ((path === '/api/dashboard/metrics' || path.endsWith('/dashboard/metrics')) && req.method === 'GET') {
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
    }

    // Get accounts
    if ((path === '/api/accounts' || path.endsWith('/accounts')) && req.method === 'GET') {
      const accounts = await sql`SELECT * FROM accounts ORDER BY code, name`;
      return res.status(200).json(transformKeys(accounts));
    }

    // Get transactions
    if ((path === '/api/transactions' || path.endsWith('/transactions')) && req.method === 'GET') {
      const transactions = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        ORDER BY t.date DESC
        LIMIT 100
      `;
      return res.status(200).json(transformKeys(transactions));
    }

    // Get contacts
    if ((path === '/api/contacts' || path.endsWith('/contacts')) && req.method === 'GET') {
      const contacts = await sql`SELECT * FROM contacts ORDER BY name`;
      return res.status(200).json(transformKeys(contacts));
    }

    // Get preferences
    if ((path === '/api/preferences' || path === '/api/settings/preferences' || path.endsWith('/preferences')) && req.method === 'GET') {
      const prefs = await sql`SELECT * FROM preferences LIMIT 1`;
      if (prefs.length > 0) {
        return res.status(200).json(transformKeys(prefs[0]));
      }
      // Return defaults
      return res.status(200).json({
        homeCurrency: 'CAD',
        dateFormat: 'MM/DD/YYYY',
        theme: 'classic'
      });
    }

    // Search endpoint (return empty for now)
    if (path.startsWith('/api/search')) {
      return res.status(200).json({
        transactions: [],
        contacts: [],
        accounts: [],
        products: []
      });
    }

    // Get sales taxes
    if ((path === '/api/sales-taxes' || path.endsWith('/sales-taxes')) && req.method === 'GET') {
      const salesTaxes = await sql`SELECT * FROM sales_taxes ORDER BY name`;
      return res.status(200).json(transformKeys(salesTaxes));
    }

    // Get account balances report
    if ((path === '/api/reports/account-balances' || path.endsWith('/account-balances')) && req.method === 'GET') {
      const accounts = await sql`
        SELECT id, code, name, type, currency, balance, is_active, cash_flow_category
        FROM accounts
        WHERE is_active = true
        ORDER BY code, name
      `;
      // Frontend expects { account: {...}, balance: number }[] format
      const result = accounts.map((acc: any) => ({
        account: transformKeys(acc),
        balance: Number(acc.balance) || 0
      }));
      return res.status(200).json(result);
    }

    // Get products
    if ((path === '/api/products' || path.endsWith('/products')) && req.method === 'GET') {
      const products = await sql`SELECT * FROM products WHERE is_active = true ORDER BY name`;
      return res.status(200).json(transformKeys(products));
    }

    // Delete transaction
    const deleteTransactionMatch = path.match(/\/api\/transactions\/(\d+)$/);
    if (deleteTransactionMatch && req.method === 'DELETE') {
      const transactionId = parseInt(deleteTransactionMatch[1]);

      // First delete related line_items
      await sql`DELETE FROM line_items WHERE transaction_id = ${transactionId}`;

      // Delete related ledger_entries
      await sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`;

      // Delete related payment_applications (where this is the payment or invoice)
      await sql`DELETE FROM payment_applications WHERE payment_id = ${transactionId} OR invoice_id = ${transactionId}`;

      // Finally delete the transaction
      await sql`DELETE FROM transactions WHERE id = ${transactionId}`;

      return res.status(200).json({ success: true, message: 'Transaction deleted' });
    }

    // Get invoices
    if ((path === '/api/invoices' || path.endsWith('/invoices')) && req.method === 'GET') {
      const invoices = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'invoice'
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(invoices));
    }

    // Get next invoice number
    if ((path === '/api/invoices/next-number' || path.endsWith('/invoices/next-number')) && req.method === 'GET') {
      const result = await sql`
        SELECT reference FROM transactions
        WHERE type = 'invoice' AND reference LIKE 'INV-%'
        ORDER BY id DESC LIMIT 1
      `;
      let nextNumber = 1001;
      if (result.length > 0 && result[0].reference) {
        const match = result[0].reference.match(/INV-(\d+)/);
        if (match) {
          nextNumber = parseInt(match[1]) + 1;
        }
      }
      return res.status(200).json({ nextNumber: `INV-${nextNumber}` });
    }

    // Get bills
    if ((path === '/api/bills' || path.endsWith('/bills')) && req.method === 'GET') {
      const bills = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'bill'
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(bills));
    }

    // Get ledger entries
    if ((path === '/api/ledger-entries' || path.endsWith('/ledger-entries')) && req.method === 'GET') {
      const entries = await sql`
        SELECT le.*, a.name as account_name, a.code as account_code, t.reference, t.type as transaction_type
        FROM ledger_entries le
        LEFT JOIN accounts a ON le.account_id = a.id
        LEFT JOIN transactions t ON le.transaction_id = t.id
        ORDER BY le.date DESC, le.id DESC
        LIMIT 500
      `;
      return res.status(200).json(transformKeys(entries));
    }

    // Get opening balance ledger entries
    if ((path === '/api/ledger-entries/opening-balance' || path.endsWith('/opening-balance')) && req.method === 'GET') {
      const entries = await sql`
        SELECT * FROM ledger_entries WHERE description LIKE '%Opening%' ORDER BY date DESC
      `;
      return res.status(200).json(transformKeys(entries));
    }

    // Get deposits
    if ((path === '/api/transactions/deposits' || path.endsWith('/deposits')) && req.method === 'GET') {
      const deposits = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'deposit'
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(deposits));
    }

    // Get recurring transactions
    if ((path === '/api/recurring' || path.endsWith('/recurring')) && req.method === 'GET') {
      const recurring = await sql`SELECT * FROM recurring_transactions ORDER BY next_date`;
      return res.status(200).json(transformKeys(recurring));
    }

    // Get company settings
    if ((path === '/api/companies/settings' || path.endsWith('/companies/settings')) && req.method === 'GET') {
      const prefs = await sql`SELECT * FROM preferences LIMIT 1`;
      if (prefs.length > 0) {
        return res.status(200).json(transformKeys(prefs[0]));
      }
      return res.status(200).json({ homeCurrency: 'CAD', dateFormat: 'MM/DD/YYYY' });
    }

    // Get currencies
    if ((path === '/api/currencies' || path.endsWith('/currencies')) && req.method === 'GET') {
      return res.status(200).json([
        { code: 'CAD', name: 'Canadian Dollar', symbol: '$' },
        { code: 'USD', name: 'US Dollar', symbol: '$' },
        { code: 'EUR', name: 'Euro', symbol: '€' },
        { code: 'GBP', name: 'British Pound', symbol: '£' },
        { code: 'INR', name: 'Indian Rupee', symbol: '₹' }
      ]);
    }

    // Income Statement report
    if ((path === '/api/reports/income-statement' || path.endsWith('/income-statement')) && req.method === 'GET') {
      const income = await sql`
        SELECT a.id, a.name, a.code, COALESCE(SUM(le.credit - le.debit), 0) as total
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'income'
        GROUP BY a.id, a.name, a.code
        ORDER BY a.code
      `;
      const expenses = await sql`
        SELECT a.id, a.name, a.code, COALESCE(SUM(le.debit - le.credit), 0) as total
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'expense'
        GROUP BY a.id, a.name, a.code
        ORDER BY a.code
      `;
      const totalIncome = income.reduce((sum: number, i: any) => sum + Number(i.total), 0);
      const totalExpenses = expenses.reduce((sum: number, e: any) => sum + Number(e.total), 0);
      return res.status(200).json({
        income: transformKeys(income),
        expenses: transformKeys(expenses),
        totalIncome,
        totalExpenses,
        netIncome: totalIncome - totalExpenses
      });
    }

    // Balance Sheet report
    if ((path === '/api/reports/balance-sheet' || path.endsWith('/balance-sheet')) && req.method === 'GET') {
      const assets = await sql`
        SELECT a.id, a.name, a.code, a.balance as total
        FROM accounts a
        WHERE a.type IN ('bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset')
        AND a.is_active = true
        ORDER BY a.code
      `;
      const liabilities = await sql`
        SELECT a.id, a.name, a.code, a.balance as total
        FROM accounts a
        WHERE a.type IN ('accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability')
        AND a.is_active = true
        ORDER BY a.code
      `;
      const equity = await sql`
        SELECT a.id, a.name, a.code, a.balance as total
        FROM accounts a
        WHERE a.type = 'equity'
        AND a.is_active = true
        ORDER BY a.code
      `;
      const totalAssets = assets.reduce((sum: number, a: any) => sum + Number(a.total), 0);
      const totalLiabilities = liabilities.reduce((sum: number, l: any) => sum + Number(l.total), 0);
      const totalEquity = equity.reduce((sum: number, e: any) => sum + Number(e.total), 0);
      return res.status(200).json({
        assets: transformKeys(assets),
        liabilities: transformKeys(liabilities),
        equity: transformKeys(equity),
        totalAssets,
        totalLiabilities,
        totalEquity
      });
    }

    // Trial Balance report
    if ((path === '/api/reports/trial-balance' || path.endsWith('/trial-balance')) && req.method === 'GET') {
      const accounts = await sql`
        SELECT a.id, a.name, a.code, a.type,
          COALESCE(SUM(le.debit), 0) as total_debits,
          COALESCE(SUM(le.credit), 0) as total_credits
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.debit), 0) > 0 OR COALESCE(SUM(le.credit), 0) > 0
        ORDER BY a.code
      `;
      const totalDebits = accounts.reduce((sum: number, a: any) => sum + Number(a.total_debits), 0);
      const totalCredits = accounts.reduce((sum: number, a: any) => sum + Number(a.total_credits), 0);
      return res.status(200).json({
        accounts: transformKeys(accounts),
        totalDebits,
        totalCredits
      });
    }

    // Cash Flow report
    if ((path === '/api/reports/cash-flow' || path.endsWith('/cash-flow')) && req.method === 'GET') {
      const operating = await sql`
        SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as total
        FROM transactions
        WHERE type IN ('invoice', 'expense', 'bill')
      `;
      return res.status(200).json({
        operating: { total: Number(operating[0]?.total) || 0, items: [] },
        investing: { total: 0, items: [] },
        financing: { total: 0, items: [] },
        netChange: Number(operating[0]?.total) || 0
      });
    }

    // Activity logs
    if ((path === '/api/activity-logs' || path.endsWith('/activity-logs')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // Admin users
    if ((path === '/api/admin/users' || path.endsWith('/admin/users')) && req.method === 'GET') {
      const users = await sql`SELECT id, username, email, role, is_active, created_at FROM users ORDER BY id`;
      return res.status(200).json(transformKeys(users));
    }

    // Admin companies
    if ((path === '/api/admin/companies' || path.endsWith('/admin/companies')) && req.method === 'GET') {
      const companies = await sql`SELECT * FROM companies ORDER BY id`;
      return res.status(200).json(transformKeys(companies));
    }

    // Users list
    if ((path === '/api/users' || path.endsWith('/users')) && req.method === 'GET') {
      const users = await sql`SELECT id, username, email, role, is_active FROM users WHERE is_active = true`;
      return res.status(200).json(transformKeys(users));
    }

    // Invitations
    if ((path === '/api/invitations' || path.endsWith('/invitations')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // Exchange rates
    if ((path === '/api/exchange-rates' || path.endsWith('/exchange-rates')) && req.method === 'GET') {
      const rates = await sql`SELECT * FROM exchange_rates ORDER BY date DESC LIMIT 100`;
      return res.status(200).json(transformKeys(rates));
    }

    // Exchange rate for specific currency
    if ((path === '/api/exchange-rates/rate' || path.endsWith('/exchange-rates/rate')) && req.method === 'GET') {
      return res.status(200).json({ rate: 1.0 });
    }

    // Categorization rules
    if ((path === '/api/categorization-rules' || path.endsWith('/categorization-rules')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // FX Revaluations
    if ((path === '/api/fx-revaluations' || path.endsWith('/fx-revaluations')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // Reconciliations
    if ((path === '/api/reconciliations' || path.endsWith('/reconciliations')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // Imported transactions
    if ((path === '/api/imported-transactions' || path.endsWith('/imported-transactions')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // Plaid endpoints (return empty - Plaid not configured)
    if (path.startsWith('/api/plaid')) {
      if (path.includes('/link-token')) {
        return res.status(200).json({ linkToken: null, error: 'Plaid not configured' });
      }
      if (path.includes('/accounts')) {
        return res.status(200).json([]);
      }
      if (path.includes('/connections')) {
        return res.status(200).json([]);
      }
      if (path.includes('/imported-transactions')) {
        return res.status(200).json([]);
      }
      return res.status(200).json([]);
    }

    // Create invoice
    if ((path === '/api/invoices' || path.endsWith('/invoices')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, balance, currency, status, memo, sub_total)
        VALUES ('invoice', ${data.reference}, ${data.date}, ${data.dueDate}, ${data.contactId}, ${data.amount}, ${data.amount}, ${data.currency || 'CAD'}, 'open', ${data.memo || ''}, ${data.subTotal || data.amount})
        RETURNING id
      `;
      return res.status(201).json({ id: result[0].id, success: true });
    }

    // Create bill
    if ((path === '/api/bills' || path.endsWith('/bills')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, balance, currency, status, memo, sub_total)
        VALUES ('bill', ${data.reference}, ${data.date}, ${data.dueDate}, ${data.contactId}, ${data.amount}, ${data.amount}, ${data.currency || 'CAD'}, 'open', ${data.memo || ''}, ${data.subTotal || data.amount})
        RETURNING id
      `;
      return res.status(201).json({ id: result[0].id, success: true });
    }

    // Create vendor credit
    if ((path === '/api/vendor-credits' || path.endsWith('/vendor-credits')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, currency, status, memo)
        VALUES ('vendor_credit', ${data.reference}, ${data.date}, ${data.contactId}, ${data.amount}, ${data.currency || 'CAD'}, 'open', ${data.memo || ''})
        RETURNING id
      `;
      return res.status(201).json({ id: result[0].id, success: true });
    }

    // Create contact
    if ((path === '/api/contacts' || path.endsWith('/contacts')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO contacts (name, contact_name, email, phone, address, type, currency, is_active)
        VALUES (${data.name}, ${data.contactName || ''}, ${data.email || ''}, ${data.phone || ''}, ${data.address || ''}, ${data.type || 'customer'}, ${data.currency || 'CAD'}, true)
        RETURNING id
      `;
      return res.status(201).json(transformKeys({ id: result[0].id, ...data }));
    }

    // Update contact
    const updateContactMatch = path.match(/\/api\/contacts\/(\d+)$/);
    if (updateContactMatch && req.method === 'PUT') {
      const contactId = parseInt(updateContactMatch[1]);
      const data = req.body;
      await sql`
        UPDATE contacts SET
          name = ${data.name},
          contact_name = ${data.contactName || ''},
          email = ${data.email || ''},
          phone = ${data.phone || ''},
          address = ${data.address || ''},
          type = ${data.type || 'customer'},
          currency = ${data.currency || 'CAD'},
          is_active = ${data.isActive !== false}
        WHERE id = ${contactId}
      `;
      return res.status(200).json({ success: true });
    }

    // Delete contact
    if (updateContactMatch && req.method === 'DELETE') {
      const contactId = parseInt(updateContactMatch[1]);
      await sql`DELETE FROM contacts WHERE id = ${contactId}`;
      return res.status(200).json({ success: true });
    }

    // Create account
    if ((path === '/api/accounts' || path.endsWith('/accounts')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO accounts (code, name, type, currency, balance, is_active)
        VALUES (${data.code}, ${data.name}, ${data.type}, ${data.currency || 'CAD'}, 0, true)
        RETURNING id
      `;
      return res.status(201).json(transformKeys({ id: result[0].id, ...data }));
    }

    // Update account
    const updateAccountMatch = path.match(/\/api\/accounts\/(\d+)$/);
    if (updateAccountMatch && req.method === 'PUT') {
      const accountId = parseInt(updateAccountMatch[1]);
      const data = req.body;
      await sql`
        UPDATE accounts SET
          code = ${data.code},
          name = ${data.name},
          type = ${data.type},
          currency = ${data.currency || 'CAD'},
          is_active = ${data.isActive !== false}
        WHERE id = ${accountId}
      `;
      return res.status(200).json({ success: true });
    }

    // Delete account
    if (updateAccountMatch && req.method === 'DELETE') {
      const accountId = parseInt(updateAccountMatch[1]);
      await sql`DELETE FROM accounts WHERE id = ${accountId}`;
      return res.status(200).json({ success: true });
    }

    // Batch transactions
    if ((path === '/api/transactions/batch' || path.endsWith('/transactions/batch')) && req.method === 'POST') {
      const { transactions: txns } = req.body;
      const results = [];
      for (const txn of txns || []) {
        const result = await sql`
          INSERT INTO transactions (type, reference, date, contact_id, amount, currency, status, memo)
          VALUES (${txn.type}, ${txn.reference}, ${txn.date}, ${txn.contactId}, ${txn.amount}, ${txn.currency || 'CAD'}, ${txn.status || 'completed'}, ${txn.memo || ''})
          RETURNING id
        `;
        results.push(result[0].id);
      }
      return res.status(201).json({ ids: results, success: true });
    }

    // Delete payment
    const deletePaymentMatch = path.match(/\/api\/payments\/(\d+)\/delete$/);
    if (deletePaymentMatch && req.method === 'DELETE') {
      const paymentId = parseInt(deletePaymentMatch[1]);
      await sql`DELETE FROM payment_applications WHERE payment_id = ${paymentId}`;
      await sql`DELETE FROM ledger_entries WHERE transaction_id = ${paymentId}`;
      await sql`DELETE FROM transactions WHERE id = ${paymentId}`;
      return res.status(200).json({ success: true });
    }

    // Apply categorization rules
    if ((path === '/api/categorization-rules/apply' || path.endsWith('/categorization-rules/apply')) && req.method === 'POST') {
      return res.status(200).json({ applied: 0 });
    }

    // Update exchange rate
    if ((path === '/api/exchange-rates' || path.endsWith('/exchange-rates')) && req.method === 'PUT') {
      const data = req.body;
      await sql`
        INSERT INTO exchange_rates (from_currency, to_currency, rate, date)
        VALUES (${data.fromCurrency}, ${data.toCurrency}, ${data.rate}, ${data.date || new Date().toISOString()})
        ON CONFLICT (from_currency, to_currency, date) DO UPDATE SET rate = ${data.rate}
      `;
      return res.status(200).json({ success: true });
    }

    // Get single transaction
    const getTransactionMatch = path.match(/\/api\/transactions\/(\d+)$/);
    if (getTransactionMatch && req.method === 'GET') {
      const transactionId = parseInt(getTransactionMatch[1]);
      const transactions = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${transactionId}
      `;
      if (transactions.length === 0) {
        return res.status(404).json({ message: 'Transaction not found' });
      }
      // Get line items
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${transactionId}`;
      return res.status(200).json(transformKeys({ ...transactions[0], lineItems }));
    }

    // Get single invoice
    const getInvoiceMatch = path.match(/\/api\/invoices\/(\d+)$/);
    if (getInvoiceMatch && req.method === 'GET') {
      const invoiceId = parseInt(getInvoiceMatch[1]);
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.email as contact_email, c.address as contact_address
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId} AND t.type = 'invoice'
      `;
      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;
      return res.status(200).json(transformKeys({ ...invoices[0], lineItems }));
    }

    // Public invoice (for sharing)
    const publicInvoiceMatch = path.match(/\/api\/invoices\/public\/([^/]+)$/);
    if (publicInvoiceMatch && req.method === 'GET') {
      const token = publicInvoiceMatch[1];
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.email as contact_email, c.address as contact_address
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.public_token = ${token} AND t.type = 'invoice'
      `;
      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoices[0].id}`;
      return res.status(200).json(transformKeys({ ...invoices[0], lineItems }));
    }

    return res.status(404).json({ message: 'Not found', path, url: req.url });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({
      message: 'Server error',
      error: error.message
    });
  }
}
