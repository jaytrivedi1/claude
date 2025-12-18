import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { Resend } from 'resend';
import Stripe from 'stripe';

const scryptAsync = promisify(scrypt);

// ============================================
// External API Clients (lazy initialization)
// ============================================

// Plaid Client
let plaidClient: PlaidApi | null = null;
function getPlaidClient(): PlaidApi | null {
  if (plaidClient) return plaidClient;

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';

  if (!clientId || !secret) {
    return null;
  }

  const configuration = new Configuration({
    basePath: PlaidEnvironments[env as keyof typeof PlaidEnvironments],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });

  plaidClient = new PlaidApi(configuration);
  return plaidClient;
}

// Resend Client
let resendClient: Resend | null = null;
function getResendClient(): Resend | null {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  resendClient = new Resend(apiKey);
  return resendClient;
}

// Stripe Client
let stripeClient: Stripe | null = null;
function getStripeClient(): Stripe | null {
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  stripeClient = new Stripe(secretKey, {
    apiVersion: '2024-12-18.acacia',
  });
  return stripeClient;
}

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

    // ============================================
    // PLAID INTEGRATION ENDPOINTS
    // ============================================

    // Create Plaid link token
    if ((path === '/api/plaid/link-token' || path.endsWith('/plaid/link-token')) && req.method === 'POST') {
      const plaid = getPlaidClient();
      if (!plaid) {
        return res.status(200).json({ linkToken: null, error: 'Plaid not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to environment.' });
      }

      try {
        const response = await plaid.linkTokenCreate({
          user: { client_user_id: `user_${userId || 'default'}` },
          client_name: 'Vedo Bookkeeping',
          products: [Products.Transactions],
          country_codes: [CountryCode.Us, CountryCode.Ca],
          language: 'en',
        });
        return res.status(200).json({ link_token: response.data.link_token });
      } catch (error: any) {
        console.error('Plaid link token error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Exchange Plaid public token for access token
    if ((path === '/api/plaid/exchange-token' || path.endsWith('/plaid/exchange-token')) && req.method === 'POST') {
      const plaid = getPlaidClient();
      if (!plaid) {
        return res.status(500).json({ error: 'Plaid not configured' });
      }

      try {
        const { public_token, accountId } = req.body;
        if (!public_token) {
          return res.status(400).json({ error: 'public_token is required' });
        }

        // Exchange public token
        const tokenResponse = await plaid.itemPublicTokenExchange({ public_token });
        const accessToken = tokenResponse.data.access_token;
        const itemId = tokenResponse.data.item_id;

        // Get institution info
        const itemResponse = await plaid.itemGet({ access_token: accessToken });
        const institutionId = itemResponse.data.item.institution_id;

        let institutionName = 'Unknown Bank';
        if (institutionId) {
          try {
            const instResponse = await plaid.institutionsGetById({
              institution_id: institutionId,
              country_codes: [CountryCode.Us, CountryCode.Ca],
            });
            institutionName = instResponse.data.institution.name;
          } catch {}
        }

        // Get accounts from Plaid
        const accountsResponse = await plaid.accountsGet({ access_token: accessToken });

        // Store bank connection
        const connectionResult = await sql`
          INSERT INTO bank_connections (plaid_item_id, plaid_access_token, institution_name, institution_id, status, last_sync)
          VALUES (${itemId}, ${accessToken}, ${institutionName}, ${institutionId}, 'active', NOW())
          RETURNING id
        `;
        const connectionId = connectionResult[0].id;

        // Store bank accounts
        const bankAccounts = [];
        const linkedAccountId = accountId ? parseInt(accountId) : null;
        let isFirstAccount = true;

        for (const account of accountsResponse.data.accounts) {
          const bankAccount = await sql`
            INSERT INTO bank_accounts (connection_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, linked_account_id, is_active)
            VALUES (${connectionId}, ${account.account_id}, ${account.name}, ${account.official_name}, ${account.type}, ${account.subtype}, ${account.mask}, ${account.balances.current}, ${account.balances.available}, ${isFirstAccount ? linkedAccountId : null}, true)
            RETURNING *
          `;
          bankAccounts.push(bankAccount[0]);
          isFirstAccount = false;
        }

        return res.status(200).json({ connection: { id: connectionId, institutionName }, bankAccounts: transformKeys(bankAccounts) });
      } catch (error: any) {
        console.error('Plaid exchange token error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Get Plaid connections
    if ((path === '/api/plaid/connections' || path.endsWith('/plaid/connections')) && req.method === 'GET') {
      const connections = await sql`SELECT * FROM bank_connections WHERE status = 'active' ORDER BY id`;
      return res.status(200).json(transformKeys(connections));
    }

    // Get Plaid bank accounts
    if ((path === '/api/plaid/accounts' || path.endsWith('/plaid/accounts')) && req.method === 'GET') {
      const accounts = await sql`SELECT * FROM bank_accounts WHERE is_active = true ORDER BY id`;
      return res.status(200).json(transformKeys(accounts));
    }

    // Sync Plaid transactions
    const syncTransactionsMatch = path.match(/\/api\/plaid\/sync-transactions\/(\d+)$/);
    if (syncTransactionsMatch && req.method === 'POST') {
      const plaid = getPlaidClient();
      if (!plaid) {
        return res.status(500).json({ error: 'Plaid not configured' });
      }

      try {
        const accountId = parseInt(syncTransactionsMatch[1]);
        const bankAccounts = await sql`SELECT * FROM bank_accounts WHERE id = ${accountId}`;
        if (bankAccounts.length === 0) {
          return res.status(404).json({ error: 'Bank account not found' });
        }
        const bankAccount = bankAccounts[0];

        const connections = await sql`SELECT * FROM bank_connections WHERE id = ${bankAccount.connection_id}`;
        if (connections.length === 0) {
          return res.status(404).json({ error: 'Bank connection not found' });
        }
        const connection = connections[0];

        // Get transactions from Plaid (last 30 days)
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const endDate = new Date();

        const transactionsResponse = await plaid.transactionsGet({
          access_token: connection.plaid_access_token,
          start_date: startDate.toISOString().split('T')[0],
          end_date: endDate.toISOString().split('T')[0],
          options: { account_ids: [bankAccount.plaid_account_id] },
        });

        const transactions = transactionsResponse.data.transactions;
        const importedTransactions = [];

        for (const tx of transactions) {
          // Check if already imported
          const existing = await sql`SELECT id FROM imported_transactions WHERE plaid_transaction_id = ${tx.transaction_id}`;
          if (existing.length > 0) continue;

          const imported = await sql`
            INSERT INTO imported_transactions (bank_account_id, plaid_transaction_id, date, posted_date, name, merchant_name, amount, currency, category, pending, payment_channel, status, source)
            VALUES (${bankAccount.id}, ${tx.transaction_id}, ${tx.date}, ${tx.authorized_date}, ${tx.name}, ${tx.merchant_name}, ${-tx.amount}, ${tx.iso_currency_code || 'USD'}, ${JSON.stringify(tx.category)}, ${tx.pending}, ${tx.payment_channel}, 'unmatched', 'plaid')
            RETURNING *
          `;
          importedTransactions.push(imported[0]);
        }

        // Update last sync time
        await sql`UPDATE bank_accounts SET last_synced_at = NOW() WHERE id = ${bankAccount.id}`;
        await sql`UPDATE bank_connections SET last_sync = NOW() WHERE id = ${connection.id}`;

        return res.status(200).json({ synced: importedTransactions.length, total: transactions.length, transactions: transformKeys(importedTransactions) });
      } catch (error: any) {
        console.error('Plaid sync error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Get imported transactions
    if ((path === '/api/plaid/imported-transactions' || path.endsWith('/plaid/imported-transactions')) && req.method === 'GET') {
      const { status } = req.query as { status?: string };
      let transactions;
      if (status) {
        transactions = await sql`SELECT * FROM imported_transactions WHERE status = ${status} ORDER BY date DESC`;
      } else {
        transactions = await sql`SELECT * FROM imported_transactions ORDER BY date DESC`;
      }
      return res.status(200).json(transformKeys(transactions));
    }

    // Delete Plaid connection
    const deleteConnectionMatch = path.match(/\/api\/plaid\/connections\/(\d+)$/);
    if (deleteConnectionMatch && req.method === 'DELETE') {
      const connectionId = parseInt(deleteConnectionMatch[1]);
      await sql`DELETE FROM bank_accounts WHERE connection_id = ${connectionId}`;
      await sql`DELETE FROM bank_connections WHERE id = ${connectionId}`;
      return res.status(200).json({ success: true });
    }

    // Delete imported transaction (soft delete)
    const deleteImportedMatch = path.match(/\/api\/plaid\/imported-transactions\/(\d+)$/);
    if (deleteImportedMatch && req.method === 'DELETE') {
      const txId = parseInt(deleteImportedMatch[1]);
      await sql`UPDATE imported_transactions SET status = 'deleted' WHERE id = ${txId}`;
      return res.status(200).json({ success: true });
    }

    // Restore imported transaction
    const restoreImportedMatch = path.match(/\/api\/plaid\/imported-transactions\/(\d+)\/restore$/);
    if (restoreImportedMatch && req.method === 'POST') {
      const txId = parseInt(restoreImportedMatch[1]);
      await sql`UPDATE imported_transactions SET status = 'unmatched' WHERE id = ${txId}`;
      return res.status(200).json({ success: true });
    }

    // ============================================
    // RADAR ADDRESS AUTOCOMPLETE
    // ============================================

    if ((path === '/api/address/autocomplete' || path.endsWith('/address/autocomplete')) && req.method === 'GET') {
      const query = req.query.query as string;

      if (!query || query.length < 3) {
        return res.status(200).json([]);
      }

      const radarApiKey = process.env.RADAR_API_KEY;
      if (!radarApiKey) {
        return res.status(500).json({ error: 'Radar API key not configured' });
      }

      try {
        const response = await fetch(
          `https://api.radar.io/v1/search/autocomplete?query=${encodeURIComponent(query)}`,
          { headers: { 'Authorization': radarApiKey } }
        );
        const data = await response.json();
        return res.status(200).json(data.addresses || []);
      } catch (error: any) {
        console.error('Radar API error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ============================================
    // RESEND EMAIL ENDPOINTS
    // ============================================

    // Send invoice email
    if ((path === '/api/email/send-invoice' || path.endsWith('/email/send-invoice')) && req.method === 'POST') {
      const resend = getResendClient();
      const fromEmail = process.env.RESEND_FROM_EMAIL;

      if (!resend || !fromEmail) {
        return res.status(500).json({ error: 'Email service not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL.' });
      }

      try {
        const { to, subject, invoiceId, html } = req.body;

        if (!to || !subject) {
          return res.status(400).json({ error: 'to and subject are required' });
        }

        const result = await resend.emails.send({
          from: fromEmail,
          to: Array.isArray(to) ? to : [to],
          subject,
          html: html || `<p>Please find your invoice attached.</p>`,
        });

        return res.status(200).json({ success: true, id: result.data?.id });
      } catch (error: any) {
        console.error('Resend error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ============================================
    // STRIPE PAYMENT ENDPOINTS
    // ============================================

    // Create Stripe checkout session
    if ((path === '/api/stripe/checkout-session' || path.endsWith('/stripe/checkout-session')) && req.method === 'POST') {
      const stripe = getStripeClient();
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY.' });
      }

      try {
        const { invoiceId, amount, currency, customerEmail, description, successUrl, cancelUrl } = req.body;

        if (!amount || !successUrl || !cancelUrl) {
          return res.status(400).json({ error: 'amount, successUrl, and cancelUrl are required' });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          customer_email: customerEmail,
          line_items: [{
            price_data: {
              currency: (currency || 'usd').toLowerCase(),
              product_data: { name: description || 'Invoice Payment' },
              unit_amount: Math.round(amount * 100), // Convert to cents
            },
            quantity: 1,
          }],
          metadata: invoiceId ? { invoiceId: invoiceId.toString() } : undefined,
          success_url: successUrl,
          cancel_url: cancelUrl,
        });

        return res.status(200).json({ sessionId: session.id, url: session.url });
      } catch (error: any) {
        console.error('Stripe error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Get Stripe checkout session status
    const stripeSessionMatch = path.match(/\/api\/stripe\/session\/([^/]+)$/);
    if (stripeSessionMatch && req.method === 'GET') {
      const stripe = getStripeClient();
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
      }

      try {
        const sessionId = stripeSessionMatch[1];
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        return res.status(200).json({
          status: session.payment_status,
          customerEmail: session.customer_email,
          amountTotal: session.amount_total,
          currency: session.currency,
          metadata: session.metadata,
        });
      } catch (error: any) {
        console.error('Stripe session error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Stripe webhook handler
    if ((path === '/api/stripe/webhook' || path.endsWith('/stripe/webhook')) && req.method === 'POST') {
      const stripe = getStripeClient();
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!stripe || !webhookSecret) {
        return res.status(500).json({ error: 'Stripe webhook not configured' });
      }

      try {
        const signature = req.headers['stripe-signature'] as string;
        const rawBody = JSON.stringify(req.body);

        const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

        // Handle checkout.session.completed
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session;
          const invoiceId = session.metadata?.invoiceId;

          if (invoiceId) {
            // Mark invoice as paid
            await sql`UPDATE transactions SET status = 'paid', balance = 0 WHERE id = ${parseInt(invoiceId)}`;
            console.log(`Invoice ${invoiceId} marked as paid via Stripe`);
          }
        }

        return res.status(200).json({ received: true });
      } catch (error: any) {
        console.error('Stripe webhook error:', error);
        return res.status(400).json({ error: error.message });
      }
    }

    // ============================================
    // EXCHANGE RATE API
    // ============================================

    // Fetch latest exchange rates
    if ((path === '/api/exchange-rates/fetch' || path.endsWith('/exchange-rates/fetch')) && req.method === 'POST') {
      const apiKey = process.env.EXCHANGERATE_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'Exchange rate API key not configured' });
      }

      try {
        const { baseCurrency } = req.body;
        const base = baseCurrency || 'CAD';

        const response = await fetch(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/${base}`);
        const data = await response.json();

        if (data.result !== 'success') {
          return res.status(500).json({ error: 'Failed to fetch exchange rates' });
        }

        // Store rates in database
        const today = new Date().toISOString().split('T')[0];
        let stored = 0;

        for (const [currency, rate] of Object.entries(data.conversion_rates)) {
          if (currency !== base) {
            await sql`
              INSERT INTO exchange_rates (from_currency, to_currency, rate, date)
              VALUES (${base}, ${currency}, ${rate as number}, ${today})
              ON CONFLICT (from_currency, to_currency, date) DO UPDATE SET rate = ${rate as number}
            `;
            stored++;
          }
        }

        return res.status(200).json({ success: true, base, ratesStored: stored, date: today });
      } catch (error: any) {
        console.error('Exchange rate API error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Get exchange rate for specific currency pair
    if ((path === '/api/exchange-rates/convert' || path.endsWith('/exchange-rates/convert')) && req.method === 'GET') {
      const { from, to, amount } = req.query as { from?: string; to?: string; amount?: string };

      if (!from || !to) {
        return res.status(400).json({ error: 'from and to currencies are required' });
      }

      // Try to get rate from database first
      const rates = await sql`
        SELECT rate FROM exchange_rates
        WHERE from_currency = ${from} AND to_currency = ${to}
        ORDER BY date DESC LIMIT 1
      `;

      if (rates.length > 0) {
        const rate = Number(rates[0].rate);
        const convertedAmount = amount ? Number(amount) * rate : rate;
        return res.status(200).json({ from, to, rate, amount: amount ? Number(amount) : 1, converted: convertedAmount });
      }

      // If not in database, fetch from API
      const apiKey = process.env.EXCHANGERATE_API_KEY;
      if (apiKey) {
        try {
          const response = await fetch(`https://v6.exchangerate-api.com/v6/${apiKey}/pair/${from}/${to}`);
          const data = await response.json();
          if (data.result === 'success') {
            const rate = data.conversion_rate;
            const convertedAmount = amount ? Number(amount) * rate : rate;
            return res.status(200).json({ from, to, rate, amount: amount ? Number(amount) : 1, converted: convertedAmount });
          }
        } catch {}
      }

      return res.status(404).json({ error: 'Exchange rate not found' });
    }

    // Create invoice
    if ((path === '/api/invoices' || path.endsWith('/invoices')) && req.method === 'POST') {
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

      console.log('[API] Creating invoice with amount:', invoiceAmount, 'subTotal:', subTotal, 'taxAmount:', taxAmount);

      const result = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, balance, currency, status, memo, sub_total, tax_amount)
        VALUES ('invoice', ${data.reference}, ${data.date}, ${data.dueDate}, ${data.contactId}, ${invoiceAmount}, ${invoiceAmount}, ${data.currency || 'CAD'}, 'open', ${data.memo || data.description || ''}, ${subTotal}, ${taxAmount})
        RETURNING id
      `;

      // Insert line items if provided
      if (data.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id)
            VALUES (${result[0].id}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null})
          `;
        }
      }

      // Create ledger entries for double-entry accounting
      const transactionId = result[0].id;
      const invoiceRef = data.reference || `INV-${transactionId}`;
      const invoiceDate = data.date;

      // Helper function to get or create account with correct type
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        // First try to find existing account with this code
        let account = await sql`SELECT id, type, name FROM accounts WHERE code = ${code} LIMIT 1`;

        if (account.length > 0) {
          // Account exists - check if type matches
          if (account[0].type !== type) {
            // Update the type to correct value
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
            console.log(`[API] Updated account ${code} type from ${account[0].type} to ${type}`);
          }
          return account[0];
        }

        // Account doesn't exist - create it
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type, name
        `;
        console.log(`[API] Created account: ${code} - ${name} (${type})`);
        return newAccount[0];
      };

      // Get or create required accounts with CORRECT types for reports
      const arAccount = await getOrCreateAccount('1100', 'Accounts Receivable', 'accounts_receivable', 'Money owed by customers');
      const revenueAccount = await getOrCreateAccount('4000', 'Service Revenue', 'income', 'Revenue from services');
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liability', 'Tax collected on sales');

      console.log('[API] Using accounts:', {
        ar: { id: arAccount.id, type: arAccount.type },
        revenue: { id: revenueAccount.id, type: revenueAccount.type },
        tax: { id: taxPayableAccount.id, type: taxPayableAccount.type }
      });

      // Create ledger entries
      // Debit Accounts Receivable for total amount
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${arAccount.id}, ${transactionId}, ${`Invoice ${invoiceRef}`}, ${invoiceAmount}, 0, ${invoiceDate})
      `;

      // Credit Service Revenue for subtotal
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${revenueAccount.id}, ${transactionId}, ${`Invoice ${invoiceRef} - Revenue`}, 0, ${subTotal}, ${invoiceDate})
      `;

      // Credit Sales Tax Payable for tax amount (if any)
      if (taxAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxPayableAccount.id}, ${transactionId}, ${`Invoice ${invoiceRef} - Tax`}, 0, ${taxAmount}, ${invoiceDate})
        `;
      }

      // Update account balances using proper debit/credit rules
      // Asset accounts (accounts_receivable): balance += debit - credit
      // Income accounts: balance += credit - debit
      // Liability accounts: balance += credit - debit

      // AR is asset - debits increase balance
      await sql`UPDATE accounts SET balance = balance + ${invoiceAmount} WHERE id = ${arAccount.id}`;

      // Revenue is income - credits increase balance
      await sql`UPDATE accounts SET balance = balance + ${subTotal} WHERE id = ${revenueAccount.id}`;

      // Tax Payable is liability - credits increase balance
      if (taxAmount > 0) {
        await sql`UPDATE accounts SET balance = balance + ${taxAmount} WHERE id = ${taxPayableAccount.id}`;
      }

      console.log('[API] Created ledger entries for invoice:', invoiceRef, {
        arDebit: invoiceAmount,
        revenueCredit: subTotal,
        taxCredit: taxAmount
      });

      return res.status(201).json({ id: result[0].id, success: true });
    }

    // Create bill
    if ((path === '/api/bills' || path.endsWith('/bills')) && req.method === 'POST') {
      const data = req.body;

      // Calculate amounts
      let billAmount = data.totalAmount || data.amount;
      if (!billAmount && data.lineItems && Array.isArray(data.lineItems)) {
        billAmount = data.lineItems.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
      }
      billAmount = Number(billAmount) || 0;
      const subTotal = Number(data.subTotal) || billAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      console.log('[API] Creating bill with amount:', billAmount, 'subTotal:', subTotal, 'taxAmount:', taxAmount);

      const result = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, balance, currency, status, memo, sub_total, tax_amount)
        VALUES ('bill', ${data.reference}, ${data.date}, ${data.dueDate}, ${data.contactId}, ${billAmount}, ${billAmount}, ${data.currency || 'CAD'}, 'open', ${data.memo || ''}, ${subTotal}, ${taxAmount})
        RETURNING id
      `;

      const transactionId = result[0].id;
      const billRef = data.reference || `BILL-${transactionId}`;
      const billDate = data.date;

      // Insert line items if provided
      if (data.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, sales_tax_id, product_id)
            VALUES (${transactionId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.accountId || null}, ${item.salesTaxId || null}, ${item.productId || null})
          `;
        }
      }

      // Helper function to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type, name FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type, name
        `;
        console.log(`[API] Created account: ${code} - ${name} (${type})`);
        return newAccount[0];
      };

      // Get required accounts
      const apAccount = await getOrCreateAccount('2000', 'Accounts Payable', 'accounts_payable', 'Money owed to vendors');
      const expenseAccount = await getOrCreateAccount('5000', 'Cost of Goods Sold', 'cost_of_goods_sold', 'Direct costs');
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liability', 'Tax collected on sales');

      // Create ledger entries for double-entry accounting
      // Debit expense for subtotal
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${expenseAccount.id}, ${transactionId}, ${`Bill ${billRef} - Expense`}, ${subTotal}, 0, ${billDate})
      `;

      // Debit tax payable for tax (input tax credit)
      if (taxAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxPayableAccount.id}, ${transactionId}, ${`Bill ${billRef} - Tax`}, ${taxAmount}, 0, ${billDate})
        `;
      }

      // Credit Accounts Payable for total amount
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${apAccount.id}, ${transactionId}, ${`Bill ${billRef}`}, 0, ${billAmount}, ${billDate})
      `;

      // Update account balances
      // Expense (debit-normal) - debits increase balance
      await sql`UPDATE accounts SET balance = balance + ${subTotal} WHERE id = ${expenseAccount.id}`;

      // Tax Payable (credit-normal) - debits DECREASE balance (input tax credit reduces liability)
      if (taxAmount > 0) {
        await sql`UPDATE accounts SET balance = balance - ${taxAmount} WHERE id = ${taxPayableAccount.id}`;
      }

      // Accounts Payable (credit-normal) - credits increase balance
      await sql`UPDATE accounts SET balance = balance + ${billAmount} WHERE id = ${apAccount.id}`;

      console.log('[API] Created ledger entries for bill:', billRef);

      return res.status(201).json({ id: transactionId, success: true });
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
