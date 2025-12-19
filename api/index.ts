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

  // DEBUG: Log all request info
  const debugInfo = {
    url: req.url,
    method: req.method,
    query: req.query,
    headers: {
      host: req.headers.host,
      'x-forwarded-host': req.headers['x-forwarded-host'],
      'x-vercel-forwarded-for': req.headers['x-vercel-forwarded-for'],
    }
  };

  // If ?debug=1 is in the URL, return debug info
  if (req.query.debug === '1') {
    return res.status(200).json({ debug: true, ...debugInfo });
  }

  // Get the path - try multiple sources
  let path: string;

  // Source 1: _path query param from rewrite
  const rewritePath = req.query._path || req.query['_path'];

  // Source 2: path query param (alternative name)
  const pathParam = req.query.path;

  // Source 3: Parse from req.url
  const urlParts = (req.url || '').split('?');
  const urlPath = urlParts[0];

  if (typeof rewritePath === 'string' && rewritePath) {
    path = '/api/' + rewritePath;
  } else if (Array.isArray(rewritePath) && rewritePath.length > 0) {
    path = '/api/' + rewritePath.join('/');
  } else if (typeof pathParam === 'string' && pathParam) {
    path = '/api/' + pathParam;
  } else if (Array.isArray(pathParam) && pathParam.length > 0) {
    path = '/api/' + pathParam.join('/');
  } else if (urlPath && urlPath.startsWith('/api/') && urlPath !== '/api/') {
    // req.url might contain the actual path
    path = urlPath;
  } else {
    path = '/api';
  }

  const userId = req.headers['x-user-id'] as string;

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Health check
    if (path === '/api' || path === '/api/' || path === '/api/health') {
      return res.status(200).json({
        status: 'ok',
        path,
        url: req.url,
        method: req.method,
        _path: req.query._path,
        query: req.query
      });
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

    // Get single account by ID
    const accountIdMatch = path.match(/\/api\/accounts\/(\d+)$/);
    if (accountIdMatch && req.method === 'GET') {
      const accountId = parseInt(accountIdMatch[1]);
      const accounts = await sql`SELECT * FROM accounts WHERE id = ${accountId}`;
      if (accounts.length === 0) {
        return res.status(404).json({ message: 'Account not found' });
      }
      return res.status(200).json(transformKeys(accounts[0]));
    }

    // Get account ledger entries
    const accountLedgerMatch = path.match(/\/api\/accounts\/(\d+)\/ledger$/);
    if (accountLedgerMatch && req.method === 'GET') {
      const accountId = parseInt(accountLedgerMatch[1]);
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      let entries;
      if (startDate && endDate) {
        entries = await sql`
          SELECT le.*, t.type as transaction_type, t.reference, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE le.account_id = ${accountId}
          AND le.date >= ${startDate}::date AND le.date <= ${endDate}::date
          ORDER BY le.date, le.id
        `;
      } else {
        entries = await sql`
          SELECT le.*, t.type as transaction_type, t.reference, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE le.account_id = ${accountId}
          ORDER BY le.date, le.id
        `;
      }
      return res.status(200).json(transformKeys(entries));
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

    // Get next transaction reference number
    if ((path === '/api/transactions/next-reference' || path.endsWith('/transactions/next-reference')) && req.method === 'GET') {
      const type = req.query.type as string || 'TXN';
      const prefix = type.toUpperCase().substring(0, 3);
      const result = await sql`
        SELECT reference FROM transactions
        WHERE reference LIKE ${prefix + '-%'}
        ORDER BY id DESC LIMIT 1
      `;
      let nextNumber = 1001;
      if (result.length > 0 && result[0].reference) {
        const match = result[0].reference.match(new RegExp(`${prefix}-(\\d+)`));
        if (match) {
          nextNumber = parseInt(match[1]) + 1;
        }
      }
      return res.status(200).json({ nextReference: `${prefix}-${nextNumber}` });
    }

    // Get single transaction by ID
    const transactionIdMatch = path.match(/\/api\/transactions\/(\d+)$/);
    if (transactionIdMatch && req.method === 'GET') {
      const transactionId = parseInt(transactionIdMatch[1]);
      const transactions = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${transactionId}
      `;
      if (transactions.length === 0) {
        return res.status(404).json({ message: 'Transaction not found' });
      }
      // Get line items and ledger entries
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${transactionId}`;
      const ledgerEntries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${transactionId}`;

      return res.status(200).json({
        transaction: transformKeys(transactions[0]),
        lineItems: transformKeys(lineItems),
        ledgerEntries: transformKeys(ledgerEntries)
      });
    }

    // Get transaction payment history
    const paymentHistoryMatch = path.match(/\/api\/transactions\/(\d+)\/payment-history$/);
    if (paymentHistoryMatch && req.method === 'GET') {
      const transactionId = parseInt(paymentHistoryMatch[1]);
      const payments = await sql`
        SELECT p.*, t.reference, t.date as payment_date
        FROM payment_applications p
        JOIN transactions t ON p.payment_id = t.id
        WHERE p.invoice_id = ${transactionId} OR p.bill_id = ${transactionId}
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(payments));
    }

    // Get contacts
    if ((path === '/api/contacts' || path.endsWith('/contacts')) && req.method === 'GET') {
      const contacts = await sql`SELECT * FROM contacts ORDER BY name`;
      return res.status(200).json(transformKeys(contacts));
    }

    // Get single contact by ID
    const contactIdMatch = path.match(/\/api\/contacts\/(\d+)$/);
    if (contactIdMatch && req.method === 'GET') {
      const contactId = parseInt(contactIdMatch[1]);
      const contacts = await sql`SELECT * FROM contacts WHERE id = ${contactId}`;
      if (contacts.length === 0) {
        return res.status(404).json({ message: 'Contact not found' });
      }
      return res.status(200).json(transformKeys(contacts[0]));
    }

    // Get contact transactions
    const contactTransactionsMatch = path.match(/\/api\/contacts\/(\d+)\/transactions$/);
    if (contactTransactionsMatch && req.method === 'GET') {
      const contactId = parseInt(contactTransactionsMatch[1]);
      const transactions = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.contact_id = ${contactId}
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(transactions));
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

    // Search endpoint
    if (path === '/api/search' && req.method === 'GET') {
      const query = (req.query.q as string || '').trim();
      if (!query) {
        return res.status(200).json({ transactions: [], contacts: [], accounts: [], products: [] });
      }
      const searchPattern = `%${query}%`;

      const [transactions, contacts, accounts, products] = await Promise.all([
        sql`SELECT t.*, c.name as contact_name FROM transactions t
            LEFT JOIN contacts c ON t.contact_id = c.id
            WHERE t.reference ILIKE ${searchPattern} OR t.memo ILIKE ${searchPattern}
            ORDER BY t.date DESC LIMIT 20`,
        sql`SELECT * FROM contacts WHERE name ILIKE ${searchPattern} OR email ILIKE ${searchPattern}
            ORDER BY name LIMIT 20`,
        sql`SELECT * FROM accounts WHERE name ILIKE ${searchPattern} OR code ILIKE ${searchPattern}
            ORDER BY code LIMIT 20`,
        sql`SELECT * FROM products WHERE name ILIKE ${searchPattern} OR sku ILIKE ${searchPattern}
            ORDER BY name LIMIT 20`
      ]);

      return res.status(200).json({
        transactions: transformKeys(transactions),
        contacts: transformKeys(contacts),
        accounts: transformKeys(accounts),
        products: transformKeys(products)
      });
    }

    // Search recent transactions
    if (path === '/api/search/recent' && req.method === 'GET') {
      const limit = parseInt(req.query.limit as string) || 5;
      const transactions = await sql`
        SELECT t.*, c.name as contact_name FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        ORDER BY t.updated_at DESC, t.created_at DESC
        LIMIT ${limit}
      `;
      return res.status(200).json(transformKeys(transactions));
    }

    // Get sales taxes
    if ((path === '/api/sales-taxes' || path.endsWith('/sales-taxes')) && req.method === 'GET') {
      const salesTaxes = await sql`SELECT * FROM sales_taxes ORDER BY name`;
      return res.status(200).json(transformKeys(salesTaxes));
    }

    // Get single sales tax by ID
    const salesTaxIdMatch = path.match(/\/api\/sales-taxes\/(\d+)$/);
    if (salesTaxIdMatch && req.method === 'GET') {
      const taxId = parseInt(salesTaxIdMatch[1]);
      const taxes = await sql`SELECT * FROM sales_taxes WHERE id = ${taxId}`;
      if (taxes.length === 0) {
        return res.status(404).json({ message: 'Sales tax not found' });
      }
      return res.status(200).json(transformKeys(taxes[0]));
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

    // Get single product by ID
    const productIdMatch = path.match(/\/api\/products\/(\d+)$/);
    if (productIdMatch && req.method === 'GET') {
      const productId = parseInt(productIdMatch[1]);
      const products = await sql`SELECT * FROM products WHERE id = ${productId}`;
      if (products.length === 0) {
        return res.status(404).json({ message: 'Product not found' });
      }
      return res.status(200).json(transformKeys(products[0]));
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

    // Get single invoice by ID
    const invoiceIdMatch = path.match(/\/api\/invoices\/(\d+)$/);
    if (invoiceIdMatch && req.method === 'GET') {
      const invoiceId = parseInt(invoiceIdMatch[1]);
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.display_name as contact_display_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.id = ${invoiceId} AND t.type = 'invoice'
      `;
      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }
      // Get line items and ledger entries
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;
      const ledgerEntries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

      return res.status(200).json({
        transaction: transformKeys(invoices[0]),
        lineItems: transformKeys(lineItems),
        ledgerEntries: transformKeys(ledgerEntries)
      });
    }

    // Get invoice payment applications
    const invoicePaymentsMatch = path.match(/\/api\/invoices\/(\d+)\/payment-applications$/);
    if (invoicePaymentsMatch && req.method === 'GET') {
      const invoiceId = parseInt(invoicePaymentsMatch[1]);
      const payments = await sql`
        SELECT pa.*, t.reference as payment_reference, t.date as payment_date, t.amount as payment_amount
        FROM payment_applications pa
        JOIN transactions t ON pa.payment_id = t.id
        WHERE pa.invoice_id = ${invoiceId}
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(payments));
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

    // Get ledger entries with date filtering
    if ((path === '/api/ledger-entries' || path.endsWith('/ledger-entries')) && req.method === 'GET') {
      const startDateStr = req.query.startDate as string | undefined;
      const endDateStr = req.query.endDate as string | undefined;
      const accountIdStr = req.query.accountId as string | undefined;

      let entries;
      if (startDateStr && endDateStr && accountIdStr) {
        entries = await sql`
          SELECT le.*, a.name as account_name, a.code as account_code, a.type as account_type,
                 t.reference, t.type as transaction_type, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE le.date::date >= ${startDateStr}::date AND le.date::date <= ${endDateStr}::date
            AND le.account_id = ${parseInt(accountIdStr)}
          ORDER BY le.date, le.transaction_id, le.id
        `;
      } else if (startDateStr && endDateStr) {
        entries = await sql`
          SELECT le.*, a.name as account_name, a.code as account_code, a.type as account_type,
                 t.reference, t.type as transaction_type, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE le.date::date >= ${startDateStr}::date AND le.date::date <= ${endDateStr}::date
          ORDER BY le.date, le.transaction_id, le.id
        `;
      } else if (accountIdStr) {
        entries = await sql`
          SELECT le.*, a.name as account_name, a.code as account_code, a.type as account_type,
                 t.reference, t.type as transaction_type, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE le.account_id = ${parseInt(accountIdStr)}
          ORDER BY le.date DESC, le.id DESC
          LIMIT 500
        `;
      } else {
        entries = await sql`
          SELECT le.*, a.name as account_name, a.code as account_code, a.type as account_type,
                 t.reference, t.type as transaction_type, t.memo as transaction_memo,
                 c.name as contact_name, c.display_name as contact_display_name
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          LEFT JOIN contacts c ON t.contact_id = c.id
          ORDER BY le.date DESC, le.id DESC
          LIMIT 500
        `;
      }

      // Enrich entries with proper structure for frontend
      const enrichedEntries = entries.map((entry: any) => ({
        id: entry.id,
        date: entry.date,
        accountId: entry.account_id,
        transactionId: entry.transaction_id,
        debit: entry.debit,
        credit: entry.credit,
        memo: entry.memo,
        description: entry.description,
        account: {
          id: entry.account_id,
          code: entry.account_code,
          name: entry.account_name,
          type: entry.account_type
        },
        transaction: entry.transaction_type ? {
          id: entry.transaction_id,
          type: entry.transaction_type,
          reference: entry.reference,
          memo: entry.transaction_memo
        } : null,
        contactName: entry.contact_display_name || entry.contact_name || ''
      }));

      return res.status(200).json(enrichedEntries);
    }

    // Get opening balance for an account before a specific date
    if ((path === '/api/ledger-entries/opening-balance' || path.endsWith('/opening-balance')) && req.method === 'GET') {
      const accountIdStr = req.query.accountId as string | undefined;
      const beforeDateStr = req.query.beforeDate as string | undefined;

      if (!accountIdStr || !beforeDateStr) {
        return res.status(400).json({ message: "accountId and beforeDate are required" });
      }

      const accountId = parseInt(accountIdStr);

      // Get the account to check its type
      const accountResult = await sql`SELECT * FROM accounts WHERE id = ${accountId}`;
      if (accountResult.length === 0) {
        return res.status(404).json({ message: "Account not found" });
      }
      const account = accountResult[0];

      // Income and expense accounts reset to $0 at start of each fiscal period
      const isIncomeOrExpenseAccount = [
        'income', 'other_income', 'expenses', 'other_expense', 'cost_of_goods_sold'
      ].includes(account.type);

      if (isIncomeOrExpenseAccount) {
        return res.status(200).json({ openingBalance: 0 });
      }

      // For balance sheet accounts, calculate sum of all entries before the date
      // Cast timestamp to date for reliable comparison
      const result = await sql`
        SELECT
          COALESCE(SUM(debit), 0) as total_debit,
          COALESCE(SUM(credit), 0) as total_credit
        FROM ledger_entries
        WHERE account_id = ${accountId}
          AND date::date < ${beforeDateStr}::date
      `;

      const totalDebit = Number(result[0]?.total_debit || 0);
      const totalCredit = Number(result[0]?.total_credit || 0);

      // Determine if account is debit-normal or credit-normal
      const creditNormalTypes = [
        'accounts_payable', 'credit_card', 'current_liabilities', 'long_term_liabilities',
        'other_current_liabilities', 'equity', 'retained_earnings', 'income', 'other_income'
      ];
      const isCreditNormal = creditNormalTypes.includes(account.type);

      let openingBalance;
      if (isCreditNormal) {
        openingBalance = totalCredit - totalDebit;
      } else {
        openingBalance = totalDebit - totalCredit;
      }

      return res.status(200).json({ openingBalance });
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

    // Get single recurring transaction by ID
    const recurringIdMatch = path.match(/\/api\/recurring\/(\d+)$/);
    if (recurringIdMatch && req.method === 'GET') {
      const recurringId = parseInt(recurringIdMatch[1]);
      const recurring = await sql`SELECT * FROM recurring_transactions WHERE id = ${recurringId}`;
      if (recurring.length === 0) {
        return res.status(404).json({ message: 'Recurring transaction not found' });
      }
      // Get line items
      const lines = await sql`SELECT * FROM recurring_lines WHERE recurring_transaction_id = ${recurringId}`;
      const result = { ...transformKeys(recurring[0]), lines: transformKeys(lines) };
      return res.status(200).json(result);
    }

    // Get company settings
    if ((path === '/api/companies/settings' || path === '/api/settings/company' || path.endsWith('/companies/settings') || path.endsWith('/settings/company')) && req.method === 'GET') {
      const companies = await sql`SELECT * FROM companies WHERE is_default = true LIMIT 1`;
      if (companies.length > 0) {
        return res.status(200).json(transformKeys(companies[0]));
      }
      // Fallback to preferences
      const prefs = await sql`SELECT * FROM preferences LIMIT 1`;
      if (prefs.length > 0) {
        return res.status(200).json(transformKeys(prefs[0]));
      }
      return res.status(200).json({ name: 'My Company', homeCurrency: 'CAD', dateFormat: 'MM/DD/YYYY' });
    }

    // POST settings/company - update company settings
    if ((path === '/api/settings/company' || path.endsWith('/settings/company')) && req.method === 'POST') {
      const body = req.body;
      const companies = await sql`SELECT * FROM companies WHERE is_default = true LIMIT 1`;
      if (companies.length > 0) {
        const updated = await sql`
          UPDATE companies SET
            name = COALESCE(${body.name}, name),
            legal_name = COALESCE(${body.legalName}, legal_name),
            email = COALESCE(${body.email}, email),
            phone = COALESCE(${body.phone}, phone),
            address = COALESCE(${body.address}, address),
            city = COALESCE(${body.city}, city),
            state = COALESCE(${body.state}, state),
            postal_code = COALESCE(${body.postalCode}, postal_code),
            country = COALESCE(${body.country}, country),
            fiscal_year_start_month = COALESCE(${body.fiscalYearStartMonth}, fiscal_year_start_month),
            updated_at = NOW()
          WHERE is_default = true
          RETURNING *
        `;
        return res.status(200).json(transformKeys(updated[0]));
      }
      return res.status(404).json({ message: 'No default company found' });
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
      // Get revenue accounts (type = 'income')
      const revenueAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type, COALESCE(SUM(le.credit - le.debit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'income'
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.credit - le.debit), 0) != 0
        ORDER BY a.code
      `;
      // Get COGS accounts
      const cogsAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type, COALESCE(SUM(le.debit - le.credit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'cost_of_goods_sold'
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.debit - le.credit), 0) != 0
        ORDER BY a.code
      `;
      // Get operating expense accounts
      const expenseAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type, COALESCE(SUM(le.debit - le.credit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'expenses'
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.debit - le.credit), 0) != 0
        ORDER BY a.code
      `;
      // Get other income accounts
      const otherIncomeAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type, COALESCE(SUM(le.credit - le.debit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'other_income'
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.credit - le.debit), 0) != 0
        ORDER BY a.code
      `;
      // Get other expense accounts
      const otherExpenseAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type, COALESCE(SUM(le.debit - le.credit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'other_expense'
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        HAVING COALESCE(SUM(le.debit - le.credit), 0) != 0
        ORDER BY a.code
      `;

      const totalRevenue = revenueAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      const totalCOGS = cogsAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      const totalExpenses = expenseAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      const totalOtherIncome = otherIncomeAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      const totalOtherExpense = otherExpenseAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);

      const grossProfit = totalRevenue - totalCOGS;
      const operatingIncome = grossProfit - totalExpenses;
      const netIncome = operatingIncome + totalOtherIncome - totalOtherExpense;

      return res.status(200).json({
        revenue: {
          accounts: revenueAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, balance: Math.round(Number(a.balance) * 100) / 100 })),
          total: Math.round(totalRevenue * 100) / 100
        },
        costOfGoodsSold: {
          accounts: cogsAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, balance: Math.round(Number(a.balance) * 100) / 100 })),
          total: Math.round(totalCOGS * 100) / 100
        },
        grossProfit: Math.round(grossProfit * 100) / 100,
        operatingExpenses: {
          accounts: expenseAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, balance: Math.round(Number(a.balance) * 100) / 100 })),
          total: Math.round(totalExpenses * 100) / 100
        },
        operatingIncome: Math.round(operatingIncome * 100) / 100,
        otherIncome: {
          accounts: otherIncomeAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, balance: Math.round(Number(a.balance) * 100) / 100 })),
          total: Math.round(totalOtherIncome * 100) / 100
        },
        otherExpense: {
          accounts: otherExpenseAccounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, balance: Math.round(Number(a.balance) * 100) / 100 })),
          total: Math.round(totalOtherExpense * 100) / 100
        },
        netIncome: Math.round(netIncome * 100) / 100
      });
    }

    // Balance Sheet report
    if ((path === '/api/reports/balance-sheet' || path.endsWith('/balance-sheet')) && req.method === 'GET') {
      // Get all asset accounts with balances from ledger entries
      const assetAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type,
          COALESCE(SUM(le.debit - le.credit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type IN ('bank', 'accounts_receivable', 'current_assets', 'property_plant_equipment', 'long_term_assets')
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        ORDER BY a.code
      `;
      // Get all liability accounts with balances from ledger entries
      const liabilityAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type,
          COALESCE(SUM(le.credit - le.debit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type IN ('accounts_payable', 'credit_card', 'other_current_liabilities', 'long_term_liabilities')
        AND a.is_active = true
        GROUP BY a.id, a.name, a.code, a.type
        ORDER BY a.code
      `;
      // Get equity accounts (excluding Retained Earnings which we calculate)
      const equityAccounts = await sql`
        SELECT a.id, a.name, a.code, a.type,
          COALESCE(SUM(le.credit - le.debit), 0) as balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON a.id = le.account_id
        WHERE a.type = 'equity'
        AND a.is_active = true
        AND a.code NOT IN ('3100', '3900')
        AND a.name != 'Retained Earnings'
        GROUP BY a.id, a.name, a.code, a.type
        ORDER BY a.code
      `;

      // Calculate Retained Earnings from income/expense accounts
      const incomeTotal = await sql`
        SELECT COALESCE(SUM(le.credit - le.debit), 0) as total
        FROM ledger_entries le
        JOIN accounts a ON le.account_id = a.id
        WHERE a.type IN ('income', 'other_income')
      `;
      const expenseTotal = await sql`
        SELECT COALESCE(SUM(le.debit - le.credit), 0) as total
        FROM ledger_entries le
        JOIN accounts a ON le.account_id = a.id
        WHERE a.type IN ('expenses', 'cost_of_goods_sold', 'other_expense')
      `;
      const retainedEarnings = Number(incomeTotal[0]?.total || 0) - Number(expenseTotal[0]?.total || 0);

      const totalAssets = assetAccounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      const totalLiabilities = liabilityAccounts.reduce((sum: number, l: any) => sum + Number(l.balance), 0);
      const otherEquity = equityAccounts.reduce((sum: number, e: any) => sum + Number(e.balance), 0);
      const totalEquity = otherEquity + retainedEarnings;

      return res.status(200).json({
        assets: {
          accounts: assetAccounts.filter((a: any) => Number(a.balance) !== 0).map((a: any) => ({
            id: a.id, code: a.code, name: a.name, type: a.type,
            balance: Math.round(Number(a.balance) * 100) / 100
          })),
          total: Math.round(totalAssets * 100) / 100
        },
        liabilities: {
          accounts: liabilityAccounts.filter((a: any) => Number(a.balance) !== 0).map((a: any) => ({
            id: a.id, code: a.code, name: a.name, type: a.type,
            balance: Math.round(Number(a.balance) * 100) / 100
          })),
          total: Math.round(totalLiabilities * 100) / 100
        },
        equity: {
          accounts: equityAccounts.filter((a: any) => Number(a.balance) !== 0).map((a: any) => ({
            id: a.id, code: a.code, name: a.name, type: a.type,
            balance: Math.round(Number(a.balance) * 100) / 100
          })),
          retainedEarnings: Math.round(retainedEarnings * 100) / 100,
          total: Math.round(totalEquity * 100) / 100
        },
        totalAssets: Math.round(totalAssets * 100) / 100,
        totalLiabilities: Math.round(totalLiabilities * 100) / 100,
        totalEquity: Math.round(totalEquity * 100) / 100
      });
    }

    // Trial Balance report
    if ((path === '/api/reports/trial-balance' || path.endsWith('/trial-balance')) && req.method === 'GET') {
      // Debit-normal account types (assets, expenses)
      const debitNormalTypes = ['bank', 'accounts_receivable', 'current_assets', 'property_plant_equipment', 'long_term_assets', 'expenses', 'cost_of_goods_sold', 'other_expense'];

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

      // Transform to expected format with debitBalance/creditBalance
      const result = accounts.map((a: any) => {
        const totalDebits = Number(a.total_debits) || 0;
        const totalCredits = Number(a.total_credits) || 0;
        const isDebitNormal = debitNormalTypes.includes(a.type);
        const netBalance = isDebitNormal ? (totalDebits - totalCredits) : (totalCredits - totalDebits);

        return {
          account: {
            id: a.id,
            code: a.code,
            name: a.name,
            type: a.type
          },
          debitBalance: isDebitNormal && netBalance > 0 ? Math.round(netBalance * 100) / 100 : 0,
          creditBalance: !isDebitNormal && netBalance > 0 ? Math.round(netBalance * 100) / 100 : 0,
          totalDebits: Math.round(totalDebits * 100) / 100,
          totalCredits: Math.round(totalCredits * 100) / 100
        };
      });

      return res.status(200).json(result);
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

    // General Ledger report
    if ((path === '/api/reports/general-ledger' || path.endsWith('/general-ledger')) && req.method === 'GET') {
      const startDateStr = req.query.startDate as string | undefined;
      const endDateStr = req.query.endDate as string | undefined;

      let ledgerEntries;
      if (startDateStr && endDateStr) {
        ledgerEntries = await sql`
          SELECT le.*, a.code as account_code, a.name as account_name, a.type as account_type,
                 t.type as transaction_type, t.reference as transaction_reference, t.date as transaction_date, t.status as transaction_status
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          WHERE le.date::date >= ${startDateStr}::date AND le.date::date <= ${endDateStr}::date
          ORDER BY le.date, le.id
        `;
      } else {
        ledgerEntries = await sql`
          SELECT le.*, a.code as account_code, a.name as account_name, a.type as account_type,
                 t.type as transaction_type, t.reference as transaction_reference, t.date as transaction_date, t.status as transaction_status
          FROM ledger_entries le
          LEFT JOIN accounts a ON le.account_id = a.id
          LEFT JOIN transactions t ON le.transaction_id = t.id
          ORDER BY le.date, le.id
        `;
      }

      const enrichedEntries = ledgerEntries.map((entry: any) => ({
        id: entry.id,
        date: entry.date,
        accountId: entry.account_id,
        transactionId: entry.transaction_id,
        debit: entry.debit,
        credit: entry.credit,
        memo: entry.memo,
        account: entry.account_code ? {
          id: entry.account_id,
          code: entry.account_code,
          name: entry.account_name,
          type: entry.account_type
        } : null,
        transaction: entry.transaction_type ? {
          id: entry.transaction_id,
          type: entry.transaction_type,
          reference: entry.transaction_reference,
          date: entry.transaction_date,
          status: entry.transaction_status
        } : null
      }));

      return res.status(200).json(enrichedEntries);
    }

    // General Ledger Grouped report - EXACTLY matching original implementation
    if ((path === '/api/reports/general-ledger-grouped' || path.endsWith('/general-ledger-grouped')) && req.method === 'GET') {
      try {
        const startDateStr = req.query.startDate as string | undefined;
        const endDateStr = req.query.endDate as string | undefined;
        const accountIdStr = req.query.accountId as string | undefined;
        const transactionType = req.query.transactionType as string | undefined;

        if (!startDateStr || !endDateStr) {
          return res.status(400).json({ message: "startDate and endDate are required" });
        }

        const startDate = new Date(startDateStr);
        const endDate = new Date(endDateStr);

        // Get ALL data first (matching original implementation)
        const allAccounts = await sql`SELECT * FROM accounts ORDER BY code`;
        const allTransactions = await sql`SELECT * FROM transactions`;
        const allContacts = await sql`SELECT * FROM contacts`;
        const allLedgerEntries = await sql`SELECT * FROM ledger_entries ORDER BY date, transaction_id, id`;

        // Filter accounts if specific account is requested
        const accounts = accountIdStr
          ? allAccounts.filter((acc: any) => acc.id === parseInt(accountIdStr))
          : allAccounts;

        // Create lookup maps
        const accountMap = new Map(allAccounts.map((acc: any) => [acc.id, acc]));
        const transactionMap = new Map(allTransactions.map((tx: any) => [tx.id, tx]));
        const contactMap = new Map(allContacts.map((c: any) => [c.id, c]));

        // Process each account
        const accountGroups = accounts.map((account: any) => {
          // Calculate beginning balance (all entries before start date)
          const beginningBalanceEntries = allLedgerEntries.filter((entry: any) =>
            entry.account_id === account.id && new Date(entry.date) < startDate
          );

          let beginningBalance = 0;
          beginningBalanceEntries.forEach((entry: any) => {
            beginningBalance += Number(entry.debit || 0) - Number(entry.credit || 0);
          });

          // Get entries for this account within the date range
          let accountEntries = allLedgerEntries.filter((entry: any) =>
            entry.account_id === account.id &&
            new Date(entry.date) >= startDate &&
            new Date(entry.date) <= endDate
          );

          // Filter by transaction type if specified
          if (transactionType) {
            const filteredTransactionIds = allTransactions
              .filter((tx: any) => tx.type === transactionType)
              .map((tx: any) => tx.id);
            accountEntries = accountEntries.filter((entry: any) =>
              filteredTransactionIds.includes(entry.transaction_id)
            );
          }

          // Sort by date, then transaction ID, then entry ID
          accountEntries.sort((a: any, b: any) => {
            const dateCompare = new Date(a.date).getTime() - new Date(b.date).getTime();
            if (dateCompare !== 0) return dateCompare;
            const txCompare = a.transaction_id - b.transaction_id;
            if (txCompare !== 0) return txCompare;
            return a.id - b.id;
          });

          // Calculate running balance and enrich entries
          let runningBalance = beginningBalance;
          const enrichedEntries = accountEntries.map((entry: any) => {
            const transaction = transactionMap.get(entry.transaction_id);
            const contact = transaction?.contact_id ? contactMap.get(transaction.contact_id) : null;

            // Update running balance
            const debit = Number(entry.debit || 0);
            const credit = Number(entry.credit || 0);
            runningBalance += debit - credit;

            // Find the split account (other account in the same transaction)
            const otherEntry = allLedgerEntries.find((e: any) =>
              e.transaction_id === entry.transaction_id && e.id !== entry.id
            );
            const splitAccount = otherEntry ? accountMap.get(otherEntry.account_id) : null;

            return {
              id: entry.id,
              date: entry.date,
              transactionId: entry.transaction_id,
              transactionType: transaction?.type || '',
              transactionReference: transaction?.reference || '',
              contactName: contact ? (contact.display_name || contact.name) : '',
              memo: transaction?.memo || entry.memo || '',
              splitAccountName: splitAccount?.name || 'Split',
              debit,
              credit,
              amount: debit > 0 ? debit : -credit,
              runningBalance,
              currency: transaction?.currency || null,
              exchangeRate: transaction?.exchange_rate || null,
              foreignAmount: transaction?.foreign_amount || null
            };
          });

          // Calculate total for this account
          const totalDebit = accountEntries.reduce((sum: number, e: any) => sum + Number(e.debit || 0), 0);
          const totalCredit = accountEntries.reduce((sum: number, e: any) => sum + Number(e.credit || 0), 0);
          const accountTotal = totalDebit - totalCredit;

          return {
            account: {
              id: account.id,
              code: account.code,
              name: account.name,
              type: account.type,
              currency: account.currency || null
            },
            beginningBalance,
            entries: enrichedEntries,
            totalDebit,
            totalCredit,
            accountTotal,
            endingBalance: beginningBalance + accountTotal
          };
        });

        // Filter out accounts with no activity
        const accountsWithActivity = accountGroups.filter((group: any) =>
          group.beginningBalance !== 0 || group.entries.length > 0
        );

        // Calculate grand totals
        const grandTotalDebit = accountsWithActivity.reduce((sum: number, g: any) => sum + g.totalDebit, 0);
        const grandTotalCredit = accountsWithActivity.reduce((sum: number, g: any) => sum + g.totalCredit, 0);

        return res.status(200).json({
          startDate: startDateStr,
          endDate: endDateStr,
          accountGroups: accountsWithActivity,
          grandTotalDebit,
          grandTotalCredit,
          totalAccounts: accountsWithActivity.length
        });
      } catch (error) {
        console.error("Error generating grouped general ledger:", error);
        return res.status(500).json({ message: "Failed to generate grouped general ledger" });
      }
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
      const reconciliations = await sql`
        SELECT r.*, a.name as account_name, a.code as account_code
        FROM reconciliations r
        LEFT JOIN accounts a ON r.account_id = a.id
        ORDER BY r.created_at DESC
      `;
      return res.status(200).json(transformKeys(reconciliations));
    }

    // Get single reconciliation by ID
    const reconciliationIdMatch = path.match(/\/api\/reconciliations\/(\d+)$/);
    if (reconciliationIdMatch && req.method === 'GET') {
      const reconciliationId = parseInt(reconciliationIdMatch[1]);
      const reconciliations = await sql`
        SELECT r.*, a.name as account_name, a.code as account_code
        FROM reconciliations r
        LEFT JOIN accounts a ON r.account_id = a.id
        WHERE r.id = ${reconciliationId}
      `;
      if (reconciliations.length === 0) {
        return res.status(404).json({ message: 'Reconciliation not found' });
      }
      // Get reconciliation items
      const items = await sql`SELECT * FROM reconciliation_items WHERE reconciliation_id = ${reconciliationId}`;
      const result = { ...transformKeys(reconciliations[0]), items: transformKeys(items) };
      return res.status(200).json(result);
    }

    // Imported transactions
    if ((path === '/api/imported-transactions' || path.endsWith('/imported-transactions')) && req.method === 'GET') {
      return res.status(200).json([]);
    }

    // ============================================
    // PUBLIC INVOICE ENDPOINTS
    // ============================================

    // Get public invoice by token
    const publicInvoiceMatch = path.match(/\/api\/invoices\/public\/([^/]+)$/);
    if (publicInvoiceMatch && req.method === 'GET') {
      const token = publicInvoiceMatch[1];
      const invoices = await sql`
        SELECT t.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone,
               c.billing_address as contact_address
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.secure_token = ${token} AND t.type = 'invoice'
      `;
      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found or link has expired' });
      }
      const invoice = invoices[0];
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoice.id}`;
      const company = await sql`SELECT * FROM companies WHERE is_default = true LIMIT 1`;

      return res.status(200).json({
        transaction: transformKeys(invoice),
        lineItems: transformKeys(lineItems),
        customer: invoice.contact_id ? {
          name: invoice.contact_name,
          email: invoice.contact_email,
          phone: invoice.contact_phone,
          billingAddress: invoice.contact_address
        } : null,
        company: company.length > 0 ? transformKeys(company[0]) : null
      });
    }

    // Generate invoice token
    const generateTokenMatch = path.match(/\/api\/invoices\/(\d+)\/generate-token$/);
    if (generateTokenMatch && req.method === 'POST') {
      const invoiceId = parseInt(generateTokenMatch[1]);
      const invoices = await sql`SELECT id, secure_token FROM transactions WHERE id = ${invoiceId} AND type = 'invoice'`;
      if (invoices.length === 0) {
        return res.status(404).json({ message: 'Invoice not found' });
      }

      let token = invoices[0].secure_token;
      if (!token) {
        // Generate new token
        token = require('crypto').randomBytes(32).toString('hex');
        await sql`UPDATE transactions SET secure_token = ${token} WHERE id = ${invoiceId}`;
      }
      return res.status(200).json({ token });
    }

    // Track invoice view
    const trackViewMatch = path.match(/\/api\/invoices\/public\/([^/]+)\/track-view$/);
    if (trackViewMatch && req.method === 'POST') {
      const token = trackViewMatch[1];
      // Just acknowledge - could add activity logging here
      return res.status(200).json({ success: true });
    }

    // Get invoice activities
    const invoiceActivitiesMatch = path.match(/\/api\/invoices\/(\d+)\/activities$/);
    if (invoiceActivitiesMatch && req.method === 'GET') {
      const invoiceId = parseInt(invoiceActivitiesMatch[1]);
      const activities = await sql`
        SELECT * FROM invoice_activities
        WHERE invoice_id = ${invoiceId}
        ORDER BY created_at DESC
      `;
      return res.status(200).json(transformKeys(activities));
    }

    // ============================================
    // QUOTATION ENDPOINTS
    // ============================================

    // Convert quotation to invoice
    const quotationConvertMatch = path.match(/\/api\/quotations\/(\d+)\/convert$/);
    if (quotationConvertMatch && req.method === 'POST') {
      const quotationId = parseInt(quotationConvertMatch[1]);
      const quotations = await sql`SELECT * FROM transactions WHERE id = ${quotationId} AND type = 'quotation'`;
      if (quotations.length === 0) {
        return res.status(404).json({ message: 'Quotation not found' });
      }
      const quotation = quotations[0];

      // Get line items
      const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${quotationId}`;

      // Generate new invoice number
      const lastInvoice = await sql`SELECT reference FROM transactions WHERE type = 'invoice' AND reference LIKE 'INV-%' ORDER BY id DESC LIMIT 1`;
      let nextNumber = 1001;
      if (lastInvoice.length > 0) {
        const match = lastInvoice[0].reference?.match(/INV-(\d+)/);
        if (match) nextNumber = parseInt(match[1]) + 1;
      }

      // Create invoice from quotation
      const newInvoice = await sql`
        INSERT INTO transactions (type, reference, date, due_date, contact_id, amount, sub_total, tax_amount, balance, currency, status, memo)
        VALUES ('invoice', ${'INV-' + nextNumber}, NOW(), ${quotation.due_date}, ${quotation.contact_id}, ${quotation.amount}, ${quotation.sub_total}, ${quotation.tax_amount}, ${quotation.amount}, ${quotation.currency}, 'open', ${quotation.memo})
        RETURNING id
      `;

      // Copy line items
      for (const item of lineItems) {
        await sql`
          INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, product_id, sales_tax_id)
          VALUES (${newInvoice[0].id}, ${item.description}, ${item.quantity}, ${item.unit_price}, ${item.amount}, ${item.account_id}, ${item.product_id}, ${item.sales_tax_id})
        `;
      }

      // Update quotation status
      await sql`UPDATE transactions SET status = 'converted' WHERE id = ${quotationId}`;

      return res.status(200).json({ id: newInvoice[0].id, reference: 'INV-' + nextNumber });
    }

    // Send quotation (stub - would need email service)
    const quotationSendMatch = path.match(/\/api\/quotations\/(\d+)\/send$/);
    if (quotationSendMatch && req.method === 'POST') {
      const quotationId = parseInt(quotationSendMatch[1]);
      // Mark as sent
      await sql`UPDATE transactions SET status = 'sent' WHERE id = ${quotationId} AND type = 'quotation'`;
      return res.status(200).json({ success: true, message: 'Quotation marked as sent' });
    }

    // ============================================
    // CSV IMPORT ENDPOINTS
    // ============================================

    // CSV parse preview (simplified - returns structure info)
    if ((path === '/api/csv/parse-preview' || path.endsWith('/csv/parse-preview')) && req.method === 'POST') {
      // In a full implementation, this would parse uploaded CSV file
      // For now, return expected structure
      return res.status(200).json({
        headers: ['Date', 'Description', 'Amount', 'Reference'],
        rows: [],
        rowCount: 0,
        message: 'CSV parsing requires file upload - use multipart form data'
      });
    }

    // CSV import (simplified)
    if ((path === '/api/csv/import' || path.endsWith('/csv/import')) && req.method === 'POST') {
      const data = req.body;
      const accountId = data.accountId;
      const transactions = data.transactions || [];
      let imported = 0;

      for (const tx of transactions) {
        await sql`
          INSERT INTO transactions (type, reference, date, amount, memo, status)
          VALUES ('import', ${tx.reference || null}, ${tx.date}, ${tx.amount}, ${tx.description || ''}, 'completed')
        `;
        imported++;
      }

      return res.status(200).json({ success: true, imported });
    }

    // ============================================
    // BANK FEED ADVANCED ENDPOINTS
    // ============================================

    // Match multiple invoices to one bank feed
    const matchMultipleInvoicesMatch = path.match(/\/api\/bank-feeds\/(\d+)\/match-multiple-invoices$/);
    if (matchMultipleInvoicesMatch && req.method === 'POST') {
      const bankFeedId = parseInt(matchMultipleInvoicesMatch[1]);
      const { invoiceIds } = req.body;

      if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
        return res.status(400).json({ message: 'invoiceIds array is required' });
      }

      // Update bank feed as matched
      await sql`UPDATE bank_feeds SET status = 'matched', matched_transaction_id = ${invoiceIds[0]} WHERE id = ${bankFeedId}`;

      return res.status(200).json({ success: true, matchedCount: invoiceIds.length });
    }

    // Match multiple bills to one bank feed
    const matchMultipleBillsMatch = path.match(/\/api\/bank-feeds\/(\d+)\/match-multiple-bills$/);
    if (matchMultipleBillsMatch && req.method === 'POST') {
      const bankFeedId = parseInt(matchMultipleBillsMatch[1]);
      const { billIds } = req.body;

      if (!billIds || !Array.isArray(billIds) || billIds.length === 0) {
        return res.status(400).json({ message: 'billIds array is required' });
      }

      // Update bank feed as matched
      await sql`UPDATE bank_feeds SET status = 'matched', matched_transaction_id = ${billIds[0]} WHERE id = ${bankFeedId}`;

      return res.status(200).json({ success: true, matchedCount: billIds.length });
    }

    // Get matched breakdown for bank feed
    const matchedBreakdownMatch = path.match(/\/api\/bank-feeds\/(\d+)\/matched-breakdown$/);
    if (matchedBreakdownMatch && req.method === 'GET') {
      const bankFeedId = parseInt(matchedBreakdownMatch[1]);
      const bankFeeds = await sql`
        SELECT bf.*, t.type as matched_type, t.reference as matched_reference, t.amount as matched_amount
        FROM bank_feeds bf
        LEFT JOIN transactions t ON bf.matched_transaction_id = t.id
        WHERE bf.id = ${bankFeedId}
      `;

      if (bankFeeds.length === 0) {
        return res.status(404).json({ message: 'Bank feed not found' });
      }

      return res.status(200).json(transformKeys(bankFeeds[0]));
    }

    // Bank feed categorization suggestions
    if ((path === '/api/bank-feeds/categorization-suggestions' || path.endsWith('/categorization-suggestions')) && req.method === 'POST') {
      const { description, amount } = req.body;
      // Simple rule-based suggestions
      const suggestions = [];

      const rules = await sql`SELECT * FROM categorization_rules WHERE is_active = true`;
      for (const rule of rules) {
        if (description && rule.pattern && description.toLowerCase().includes(rule.pattern.toLowerCase())) {
          suggestions.push({
            accountId: rule.account_id,
            confidence: 0.8,
            ruleName: rule.name
          });
        }
      }

      return res.status(200).json(suggestions);
    }

    // ============================================
    // USER & PERMISSIONS ENDPOINTS
    // ============================================

    // Get permissions
    if ((path === '/api/permissions' || path.endsWith('/permissions')) && req.method === 'GET') {
      const permissions = await sql`SELECT * FROM permissions ORDER BY name`;
      return res.status(200).json(transformKeys(permissions));
    }

    // Get role permissions
    const rolePermissionsMatch = path.match(/\/api\/role-permissions\/([^/]+)$/);
    if (rolePermissionsMatch && req.method === 'GET') {
      const role = rolePermissionsMatch[1];
      const permissions = await sql`
        SELECT p.* FROM permissions p
        JOIN role_permissions rp ON p.id = rp.permission_id
        WHERE rp.role = ${role}
      `;
      return res.status(200).json(transformKeys(permissions));
    }

    // Create role permission
    if ((path === '/api/role-permissions' || path.endsWith('/role-permissions')) && req.method === 'POST') {
      const { role, permissionId } = req.body;
      await sql`INSERT INTO role_permissions (role, permission_id) VALUES (${role}, ${permissionId}) ON CONFLICT DO NOTHING`;
      return res.status(201).json({ success: true });
    }

    // Delete role permission
    const deleteRolePermMatch = path.match(/\/api\/role-permissions\/([^/]+)\/(\d+)$/);
    if (deleteRolePermMatch && req.method === 'DELETE') {
      const role = deleteRolePermMatch[1];
      const permissionId = parseInt(deleteRolePermMatch[2]);
      await sql`DELETE FROM role_permissions WHERE role = ${role} AND permission_id = ${permissionId}`;
      return res.status(200).json({ success: true });
    }

    // Get user by ID
    const userIdMatch = path.match(/\/api\/users\/(\d+)$/);
    if (userIdMatch && req.method === 'GET') {
      const userId = parseInt(userIdMatch[1]);
      const users = await sql`SELECT id, username, email, role, is_active, created_at FROM users WHERE id = ${userId}`;
      if (users.length === 0) {
        return res.status(404).json({ message: 'User not found' });
      }
      return res.status(200).json(transformKeys(users[0]));
    }

    // Update user
    if (userIdMatch && req.method === 'PATCH') {
      const userId = parseInt(userIdMatch[1]);
      const { username, email, role, isActive } = req.body;
      const updated = await sql`
        UPDATE users SET
          username = COALESCE(${username}, username),
          email = COALESCE(${email}, email),
          role = COALESCE(${role}, role),
          is_active = COALESCE(${isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id, username, email, role, is_active, created_at
      `;
      if (updated.length === 0) {
        return res.status(404).json({ message: 'User not found' });
      }
      return res.status(200).json(transformKeys(updated[0]));
    }

    // Update user role
    const userRoleMatch = path.match(/\/api\/users\/(\d+)\/role$/);
    if (userRoleMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
      const userId = parseInt(userRoleMatch[1]);
      const { role } = req.body;
      await sql`UPDATE users SET role = ${role}, updated_at = NOW() WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    }

    // User companies
    if ((path === '/api/user-companies' || path.endsWith('/user-companies')) && req.method === 'GET') {
      const userCompanies = await sql`
        SELECT uc.*, u.username, u.email, c.name as company_name
        FROM user_companies uc
        JOIN users u ON uc.user_id = u.id
        JOIN companies c ON uc.company_id = c.id
      `;
      return res.status(200).json(transformKeys(userCompanies));
    }

    // Get user's companies
    const userCompaniesMatch = path.match(/\/api\/user-companies\/(\d+)$/);
    if (userCompaniesMatch && req.method === 'GET') {
      const userId = parseInt(userCompaniesMatch[1]);
      const companies = await sql`
        SELECT c.* FROM companies c
        JOIN user_companies uc ON c.id = uc.company_id
        WHERE uc.user_id = ${userId}
      `;
      return res.status(200).json(transformKeys(companies));
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
    // BANK FEED MATCHING
    // ============================================

    // Get match suggestions for bank transaction
    const suggestionsMatch = path.match(/\/api\/bank-feeds\/(\d+)\/suggestions$/);
    if (suggestionsMatch && req.method === 'GET') {
      const bankTxId = parseInt(suggestionsMatch[1]);

      // Get the imported transaction
      const bankTx = await sql`SELECT * FROM imported_transactions WHERE id = ${bankTxId} LIMIT 1`;
      if (bankTx.length === 0) {
        return res.status(404).json({ error: 'Imported transaction not found' });
      }

      const tx = bankTx[0];
      const txAmount = Math.abs(Number(tx.amount));
      const isDeposit = Number(tx.amount) > 0;
      const suggestions: any[] = [];

      // Date range for matching (30 days)
      const txDate = new Date(tx.date);
      const dateFrom = new Date(txDate);
      dateFrom.setDate(dateFrom.getDate() - 30);
      const dateTo = new Date(txDate);
      dateTo.setDate(dateTo.getDate() + 30);

      if (isDeposit) {
        // Find matching invoices
        const invoices = await sql`
          SELECT t.id, t.type, t.reference, t.description, t.amount, t.balance, t.date, t.contact_id, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE t.type = 'invoice'
          AND t.status IN ('open', 'overdue', 'partial')
          AND t.date >= ${dateFrom.toISOString().split('T')[0]}
          AND t.date <= ${dateTo.toISOString().split('T')[0]}
        `;

        for (const inv of invoices) {
          const invBalance = Number(inv.balance) || Number(inv.amount);
          const amountDiff = Math.abs(txAmount - Math.abs(invBalance));
          const amountDiffPercent = amountDiff / Math.abs(invBalance);

          let confidence = 0;
          let matchType = 'fuzzy';
          const matchReasons: string[] = [];

          // Amount matching
          if (amountDiff <= 0.01) {
            confidence += 50;
            matchType = 'exact';
            matchReasons.push('Exact amount match');
          } else if (amountDiffPercent <= 0.02) {
            confidence += 40;
            matchType = 'tolerance';
            matchReasons.push('Amount within 2% tolerance');
          } else if (amountDiffPercent <= 0.05) {
            confidence += 25;
            matchReasons.push('Amount close match');
          }

          // Date matching
          const daysDiff = Math.abs((txDate.getTime() - new Date(inv.date).getTime()) / (1000 * 60 * 60 * 24));
          if (daysDiff <= 3) {
            confidence += 20;
            matchReasons.push('Same week');
          } else if (daysDiff <= 7) {
            confidence += 15;
          } else if (daysDiff <= 14) {
            confidence += 10;
          }

          // Name matching
          if (inv.contact_name && tx.name) {
            const nameMatch = tx.name.toLowerCase().includes(inv.contact_name.toLowerCase()) ||
                             inv.contact_name.toLowerCase().includes(tx.name.toLowerCase());
            if (nameMatch) {
              confidence += 15;
              matchReasons.push('Customer name match');
            }
          }

          // Reference matching
          if (inv.reference && tx.name) {
            if (tx.name.toLowerCase().includes(inv.reference.toLowerCase())) {
              confidence += 20;
              matchReasons.push('Reference number in description');
            }
          }

          if (confidence >= 25) {
            suggestions.push({
              transactionId: inv.id,
              transactionType: 'invoice',
              reference: inv.reference,
              description: inv.description,
              amount: Number(inv.amount),
              date: inv.date,
              contactId: inv.contact_id,
              contactName: inv.contact_name,
              balance: invBalance,
              confidence,
              matchType,
              matchReason: matchReasons.join(', ')
            });
          }
        }
      } else {
        // Find matching bills
        const bills = await sql`
          SELECT t.id, t.type, t.reference, t.description, t.amount, t.balance, t.date, t.contact_id, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE t.type = 'bill'
          AND t.status IN ('open', 'overdue', 'partial')
          AND t.date >= ${dateFrom.toISOString().split('T')[0]}
          AND t.date <= ${dateTo.toISOString().split('T')[0]}
        `;

        for (const bill of bills) {
          const billBalance = Number(bill.balance) || Number(bill.amount);
          const amountDiff = Math.abs(txAmount - Math.abs(billBalance));
          const amountDiffPercent = amountDiff / Math.abs(billBalance);

          let confidence = 0;
          let matchType = 'fuzzy';
          const matchReasons: string[] = [];

          if (amountDiff <= 0.01) {
            confidence += 50;
            matchType = 'exact';
            matchReasons.push('Exact amount match');
          } else if (amountDiffPercent <= 0.02) {
            confidence += 40;
            matchType = 'tolerance';
            matchReasons.push('Amount within 2% tolerance');
          } else if (amountDiffPercent <= 0.05) {
            confidence += 25;
            matchReasons.push('Amount close match');
          }

          const daysDiff = Math.abs((txDate.getTime() - new Date(bill.date).getTime()) / (1000 * 60 * 60 * 24));
          if (daysDiff <= 3) {
            confidence += 20;
            matchReasons.push('Same week');
          } else if (daysDiff <= 7) {
            confidence += 15;
          }

          if (bill.contact_name && tx.name) {
            const nameMatch = tx.name.toLowerCase().includes(bill.contact_name.toLowerCase()) ||
                             bill.contact_name.toLowerCase().includes(tx.name.toLowerCase());
            if (nameMatch) {
              confidence += 15;
              matchReasons.push('Vendor name match');
            }
          }

          if (confidence >= 25) {
            suggestions.push({
              transactionId: bill.id,
              transactionType: 'bill',
              reference: bill.reference,
              description: bill.description,
              amount: Number(bill.amount),
              date: bill.date,
              contactId: bill.contact_id,
              contactName: bill.contact_name,
              balance: billBalance,
              confidence,
              matchType,
              matchReason: matchReasons.join(', ')
            });
          }
        }
      }

      // Sort by confidence descending
      suggestions.sort((a, b) => b.confidence - a.confidence);

      return res.status(200).json({ suggestions, count: suggestions.length });
    }

    // Match bank deposit to invoice (create payment)
    const matchInvoiceMatch = path.match(/\/api\/bank-feeds\/(\d+)\/match-invoice$/);
    if (matchInvoiceMatch && req.method === 'POST') {
      const bankTxId = parseInt(matchInvoiceMatch[1]);
      const { invoiceId } = req.body;

      if (!invoiceId) {
        return res.status(400).json({ error: 'Invoice ID is required' });
      }

      // Get imported transaction
      const bankTx = await sql`SELECT * FROM imported_transactions WHERE id = ${bankTxId} LIMIT 1`;
      if (bankTx.length === 0) {
        return res.status(404).json({ error: 'Imported transaction not found' });
      }

      const tx = bankTx[0];
      if (tx.status === 'matched') {
        return res.status(400).json({ error: 'Transaction is already matched' });
      }

      // Get invoice
      const invoice = await sql`SELECT * FROM transactions WHERE id = ${invoiceId} AND type = 'invoice' LIMIT 1`;
      if (invoice.length === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const inv = invoice[0];
      const amount = Math.abs(Number(tx.amount));
      const txDate = tx.date;

      // Create payment transaction
      const paymentRef = `PAY-${new Date(txDate).toISOString().slice(0,10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;
      const paymentResult = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('payment', ${paymentRef}, ${txDate}, ${inv.contact_id}, ${amount}, 0, 'CAD', 'completed', ${`Payment for Invoice ${inv.reference || inv.id}`})
        RETURNING id
      `;
      const paymentId = paymentResult[0].id;

      // Get accounts
      const bankAccountId = tx.bank_account_id || tx.account_id;
      let arAccountResult = await sql`SELECT id FROM accounts WHERE code IN ('1100', '1200') LIMIT 1`;
      if (arAccountResult.length === 0) {
        arAccountResult = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES ('1100', 'Accounts Receivable', 'accounts_receivable', 'Money owed by customers', 0, 'CAD', true)
          RETURNING id
        `;
      }
      const arAccountId = arAccountResult[0].id;

      // Create ledger entries
      if (bankAccountId) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${bankAccountId}, ${paymentId}, ${`Payment received - ${inv.reference || inv.id}`}, ${amount}, 0, ${txDate})
        `;
        await sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${bankAccountId}`;
      }

      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${arAccountId}, ${paymentId}, ${`Payment applied - ${inv.reference || inv.id}`}, 0, ${amount}, ${txDate})
      `;
      await sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${arAccountId}`;

      // Create payment application
      await sql`INSERT INTO payment_applications (payment_id, invoice_id, amount_applied) VALUES (${paymentId}, ${invoiceId}, ${amount})`;

      // Update invoice balance and status
      const currentBalance = Number(inv.balance) || Number(inv.amount);
      const newBalance = Math.max(0, currentBalance - amount);
      const newStatus = newBalance <= 0.01 ? 'paid' : 'partial';
      await sql`UPDATE transactions SET balance = ${newBalance}, status = ${newStatus} WHERE id = ${invoiceId}`;

      // Mark imported transaction as matched
      await sql`
        UPDATE imported_transactions
        SET matched_transaction_id = ${paymentId}, matched_transaction_type = 'payment', is_manual_match = false, status = 'matched'
        WHERE id = ${bankTxId}
      `;

      console.log('[API] Matched bank deposit to invoice:', { bankTxId, invoiceId, paymentId });
      return res.status(200).json({ success: true, paymentId, message: 'Payment created and applied to invoice' });
    }

    // Match bank payment to bill (create bill payment)
    const matchBillMatch = path.match(/\/api\/bank-feeds\/(\d+)\/match-bill$/);
    if (matchBillMatch && req.method === 'POST') {
      const bankTxId = parseInt(matchBillMatch[1]);
      const { billId } = req.body;

      if (!billId) {
        return res.status(400).json({ error: 'Bill ID is required' });
      }

      // Get imported transaction
      const bankTx = await sql`SELECT * FROM imported_transactions WHERE id = ${bankTxId} LIMIT 1`;
      if (bankTx.length === 0) {
        return res.status(404).json({ error: 'Imported transaction not found' });
      }

      const tx = bankTx[0];
      if (tx.status === 'matched') {
        return res.status(400).json({ error: 'Transaction is already matched' });
      }

      // Get bill
      const bill = await sql`SELECT * FROM transactions WHERE id = ${billId} AND type = 'bill' LIMIT 1`;
      if (bill.length === 0) {
        return res.status(404).json({ error: 'Bill not found' });
      }

      const b = bill[0];
      const amount = Math.abs(Number(tx.amount));
      const txDate = tx.date;

      // Create bill payment transaction
      const paymentRef = `BILLPAY-${new Date(txDate).toISOString().slice(0,10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;
      const paymentResult = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('bill_payment', ${paymentRef}, ${txDate}, ${b.contact_id}, ${amount}, 0, 'CAD', 'completed', ${`Payment for Bill ${b.reference || b.id}`})
        RETURNING id
      `;
      const paymentId = paymentResult[0].id;

      // Get accounts
      const bankAccountId = tx.bank_account_id || tx.account_id;
      let apAccountResult = await sql`SELECT id FROM accounts WHERE code = '2000' LIMIT 1`;
      if (apAccountResult.length === 0) {
        apAccountResult = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES ('2000', 'Accounts Payable', 'accounts_payable', 'Money owed to vendors', 0, 'CAD', true)
          RETURNING id
        `;
      }
      const apAccountId = apAccountResult[0].id;

      // Create ledger entries - debit AP, credit bank
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${apAccountId}, ${paymentId}, ${`Bill payment - ${b.reference || b.id}`}, ${amount}, 0, ${txDate})
      `;
      await sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${apAccountId}`;

      if (bankAccountId) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${bankAccountId}, ${paymentId}, ${`Bill payment - ${b.reference || b.id}`}, 0, ${amount}, ${txDate})
        `;
        await sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${bankAccountId}`;
      }

      // Create payment application
      await sql`INSERT INTO payment_applications (payment_id, invoice_id, amount_applied) VALUES (${paymentId}, ${billId}, ${amount})`;

      // Update bill balance and status
      const currentBalance = Number(b.balance) || Number(b.amount);
      const newBalance = Math.max(0, currentBalance - amount);
      const newStatus = newBalance <= 0.01 ? 'paid' : 'partial';
      await sql`UPDATE transactions SET balance = ${newBalance}, status = ${newStatus} WHERE id = ${billId}`;

      // Mark imported transaction as matched
      await sql`
        UPDATE imported_transactions
        SET matched_transaction_id = ${paymentId}, matched_transaction_type = 'payment', is_manual_match = false, status = 'matched'
        WHERE id = ${bankTxId}
      `;

      console.log('[API] Matched bank payment to bill:', { bankTxId, billId, paymentId });
      return res.status(200).json({ success: true, paymentId, message: 'Payment created and applied to bill' });
    }

    // Link bank transaction to existing manual entry
    const linkManualMatch = path.match(/\/api\/bank-feeds\/(\d+)\/link-manual$/);
    if (linkManualMatch && req.method === 'POST') {
      const bankTxId = parseInt(linkManualMatch[1]);
      const { transactionId, transactionType } = req.body;

      if (!transactionId) {
        return res.status(400).json({ error: 'Transaction ID is required' });
      }

      // Get imported transaction
      const bankTx = await sql`SELECT * FROM imported_transactions WHERE id = ${bankTxId} LIMIT 1`;
      if (bankTx.length === 0) {
        return res.status(404).json({ error: 'Imported transaction not found' });
      }

      if (bankTx[0].status === 'matched') {
        return res.status(400).json({ error: 'Transaction is already matched' });
      }

      // Mark as matched (manual link, no new transaction created)
      await sql`
        UPDATE imported_transactions
        SET matched_transaction_id = ${transactionId}, matched_transaction_type = ${transactionType || 'manual'}, is_manual_match = true, status = 'matched'
        WHERE id = ${bankTxId}
      `;

      console.log('[API] Linked bank transaction manually:', { bankTxId, transactionId });
      return res.status(200).json({ success: true, message: 'Transaction linked successfully' });
    }

    // Unmatch bank transaction
    const unmatchMatch = path.match(/\/api\/bank-feeds\/(\d+)\/unmatch$/);
    if (unmatchMatch && req.method === 'POST') {
      const bankTxId = parseInt(unmatchMatch[1]);

      // Get the imported transaction to check if it created a payment
      const bankTx = await sql`SELECT * FROM imported_transactions WHERE id = ${bankTxId} LIMIT 1`;
      if (bankTx.length === 0) {
        return res.status(404).json({ error: 'Imported transaction not found' });
      }

      const tx = bankTx[0];

      // If it was an auto-match (not manual), we need to reverse the created payment
      if (!tx.is_manual_match && tx.matched_transaction_id) {
        // Delete payment applications
        await sql`DELETE FROM payment_applications WHERE payment_id = ${tx.matched_transaction_id}`;
        // Delete ledger entries
        await sql`DELETE FROM ledger_entries WHERE transaction_id = ${tx.matched_transaction_id}`;
        // Delete the payment transaction
        await sql`DELETE FROM transactions WHERE id = ${tx.matched_transaction_id}`;
      }

      // Reset the imported transaction
      await sql`
        UPDATE imported_transactions
        SET matched_transaction_id = NULL, matched_transaction_type = NULL, is_manual_match = false, status = 'unmatched'
        WHERE id = ${bankTxId}
      `;

      console.log('[API] Unmatched bank transaction:', bankTxId);
      return res.status(200).json({ success: true, message: 'Transaction unmatched' });
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
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liabilities', 'Tax collected on sales');

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

    // Update invoice (PATCH)
    const invoicePatchMatch = path.match(/\/api\/invoices\/(\d+)$/);
    if (invoicePatchMatch && req.method === 'PATCH') {
      try {
        const invoiceId = parseInt(invoicePatchMatch[1]);
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

        // Update the invoice with all fields
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
              INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id)
              VALUES (${invoiceId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null})
            `;
          }

          // Update ledger entries for the new amounts
          await sql`DELETE FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

          // Get account IDs
          const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' LIMIT 1`;
          const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' LIMIT 1`;
          const taxPayableAccount = await sql`SELECT id FROM accounts WHERE code = '2100' LIMIT 1`;

          const invoiceDate = data.date || existingInvoice.date;
          const invoiceRef = data.reference || existingInvoice.reference || `INV-${invoiceId}`;

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

        // Fetch updated invoice with line items
        const updatedInvoice = await sql`
          SELECT t.*, c.name as contact_name
          FROM transactions t
          LEFT JOIN contacts c ON t.contact_id = c.id
          WHERE t.id = ${invoiceId}
        `;
        const lineItems = await sql`SELECT * FROM line_items WHERE transaction_id = ${invoiceId}`;
        const ledgerEntries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${invoiceId}`;

        return res.status(200).json({
          transaction: transformKeys(updatedInvoice[0]),
          lineItems: transformKeys(lineItems),
          ledgerEntries: transformKeys(ledgerEntries)
        });
      } catch (error) {
        console.error('Error updating invoice:', error);
        return res.status(500).json({ message: 'Failed to update invoice' });
      }
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
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liabilities', 'Tax collected on sales');

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

    // Create vendor credit with ledger entries
    if ((path === '/api/vendor-credits' || path.endsWith('/vendor-credits')) && req.method === 'POST') {
      const data = req.body;
      const totalAmount = Number(data.totalAmount || data.amount) || 0;
      const subTotal = Number(data.subTotal) || totalAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, sub_total, tax_amount, balance, currency, status, memo)
        VALUES ('vendor_credit', ${data.reference}, ${data.date}, ${data.contactId}, ${totalAmount}, ${subTotal}, ${taxAmount}, ${-totalAmount}, ${data.currency || 'CAD'}, 'unapplied_credit', ${data.memo || ''})
        RETURNING id
      `;
      const txId = result[0].id;

      // Create line items
      if (data.lineItems && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, sales_tax_id)
            VALUES (${txId}, ${item.description || ''}, ${item.quantity || 1}, ${item.unitPrice || item.amount}, ${item.amount}, ${item.accountId || null}, ${item.salesTaxId || null})
          `;
        }
      }

      // Create ledger entries (Debit AP, Credit Expense)
      const apAccount = await sql`SELECT id FROM accounts WHERE code = '2000' OR type = 'accounts_payable' LIMIT 1`;
      const expAccount = await sql`SELECT id FROM accounts WHERE code = '6000' OR type = 'expenses' LIMIT 1`;

      if (apAccount.length > 0 && expAccount.length > 0) {
        await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${apAccount[0].id}, ${data.date}, ${subTotal}, 0, 'Vendor credit')`;
        await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${expAccount[0].id}, ${data.date}, 0, ${subTotal}, 'Vendor credit')`;
        await sql`UPDATE accounts SET balance = balance + ${subTotal} WHERE id = ${apAccount[0].id}`;
        await sql`UPDATE accounts SET balance = balance - ${subTotal} WHERE id = ${expAccount[0].id}`;
      }

      return res.status(201).json({ id: txId, success: true });
    }

    // Create customer credit with ledger entries
    if ((path === '/api/customer-credits' || path.endsWith('/customer-credits')) && req.method === 'POST') {
      const data = req.body;
      const totalAmount = Number(data.totalAmount || data.amount) || 0;
      const subTotal = Number(data.subTotal) || totalAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, sub_total, tax_amount, balance, currency, status, memo)
        VALUES ('customer_credit', ${data.reference}, ${data.date}, ${data.contactId}, ${totalAmount}, ${subTotal}, ${taxAmount}, ${-totalAmount}, ${data.currency || 'CAD'}, 'unapplied_credit', ${data.memo || ''})
        RETURNING id
      `;
      const txId = result[0].id;

      // Create line items
      if (data.lineItems && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, sales_tax_id)
            VALUES (${txId}, ${item.description || ''}, ${item.quantity || 1}, ${item.unitPrice || item.amount}, ${item.amount}, ${item.accountId || null}, ${item.salesTaxId || null})
          `;
        }
      }

      // Create ledger entries (Debit Revenue, Credit AR)
      const arAccount = await sql`SELECT id FROM accounts WHERE code = '1100' OR type = 'accounts_receivable' LIMIT 1`;
      const revenueAccount = await sql`SELECT id FROM accounts WHERE code = '4000' OR type = 'income' LIMIT 1`;

      if (arAccount.length > 0 && revenueAccount.length > 0) {
        await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${revenueAccount[0].id}, ${data.date}, ${subTotal}, 0, 'Customer credit')`;
        await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${arAccount[0].id}, ${data.date}, 0, ${subTotal}, 'Customer credit')`;
        await sql`UPDATE accounts SET balance = balance - ${subTotal} WHERE id = ${revenueAccount[0].id}`;
        await sql`UPDATE accounts SET balance = balance - ${subTotal} WHERE id = ${arAccount[0].id}`;
      }

      return res.status(201).json({ id: txId, success: true });
    }

    // Create cheque with ledger entries
    if ((path === '/api/cheques' || path.endsWith('/cheques')) && req.method === 'POST') {
      const data = req.body;
      const totalAmount = Number(data.totalAmount || data.amount) || 0;
      const subTotal = Number(data.subTotal) || totalAmount;
      const taxAmount = Number(data.taxAmount) || 0;

      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, sub_total, tax_amount, currency, status, payment_account_id, payment_method, memo)
        VALUES ('cheque', ${data.reference}, ${data.date}, ${data.contactId || null}, ${totalAmount}, ${subTotal}, ${taxAmount}, ${data.currency || 'CAD'}, 'completed', ${data.paymentAccountId}, 'check', ${data.memo || ''})
        RETURNING id
      `;
      const txId = result[0].id;

      // Create line items
      if (data.lineItems && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          await sql`
            INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, sales_tax_id)
            VALUES (${txId}, ${item.description || ''}, ${item.quantity || 1}, ${item.unitPrice || item.amount}, ${item.amount}, ${item.accountId || null}, ${item.salesTaxId || null})
          `;

          // Create ledger entry for expense (Debit Expense)
          if (item.accountId) {
            await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${item.accountId}, ${data.date}, ${item.amount}, 0, ${item.description || 'Cheque payment'})`;
            await sql`UPDATE accounts SET balance = balance + ${item.amount} WHERE id = ${item.accountId}`;
          }
        }
      }

      // Create ledger entry for bank account (Credit Bank)
      if (data.paymentAccountId) {
        await sql`INSERT INTO ledger_entries (transaction_id, account_id, date, debit, credit, memo) VALUES (${txId}, ${data.paymentAccountId}, ${data.date}, 0, ${totalAmount}, 'Cheque payment')`;
        await sql`UPDATE accounts SET balance = balance - ${totalAmount} WHERE id = ${data.paymentAccountId}`;
      }

      return res.status(201).json({ id: txId, success: true });
    }

    // Receive payment (customer payment)
    if ((path === '/api/payments' || path.endsWith('/payments')) && req.method === 'POST') {
      const data = req.body;
      const lineItems = data.lineItems || [];
      const paymentAmount = Number(data.amount) || 0;
      const unappliedAmount = Number(data.unappliedAmount) || 0;

      console.log('[API] Processing payment:', { amount: paymentAmount, lineItems: lineItems.length, unapplied: unappliedAmount });

      // Create the payment transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('payment', ${data.reference}, ${data.date}, ${data.contactId}, ${paymentAmount}, ${unappliedAmount}, ${data.currency || 'CAD'}, ${unappliedAmount > 0 ? 'unapplied_credit' : 'completed'}, ${data.description || 'Payment received'})
        RETURNING id
      `;

      const paymentId = result[0].id;
      const paymentDate = data.date;

      // Helper to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type
        `;
        return newAccount[0];
      };

      // Get required accounts
      const bankAccount = data.depositAccountId
        ? (await sql`SELECT id, type FROM accounts WHERE id = ${data.depositAccountId} LIMIT 1`)[0]
        : await getOrCreateAccount('1000', 'Cash', 'bank', 'Cash on hand');
      const arAccount = await getOrCreateAccount('1100', 'Accounts Receivable', 'accounts_receivable', 'Money owed by customers');

      // Create ledger entries
      // Debit bank account (increase cash)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${bankAccount.id}, ${paymentId}, ${`Payment received ${data.reference || ''}`}, ${paymentAmount}, 0, ${paymentDate})
      `;

      // Process invoice payments
      const invoiceItems = lineItems.filter((item: any) => !item.type || item.type === 'invoice');
      let totalApplied = 0;

      for (const item of invoiceItems) {
        if (!item.transactionId || !item.amount) continue;
        const appliedAmount = Number(item.amount);
        totalApplied += appliedAmount;

        // Get the invoice
        const invoice = await sql`SELECT id, reference, balance, amount FROM transactions WHERE id = ${item.transactionId} LIMIT 1`;
        if (invoice.length === 0) continue;

        // Credit AR for the applied amount
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${arAccount.id}, ${paymentId}, ${`Payment applied to invoice #${invoice[0].reference}`}, 0, ${appliedAmount}, ${paymentDate})
        `;

        // Update invoice balance and status
        const currentBalance = Number(invoice[0].balance) || Number(invoice[0].amount);
        const newBalance = Math.max(0, currentBalance - appliedAmount);
        const newStatus = newBalance <= 0 ? 'paid' : 'partial';

        await sql`UPDATE transactions SET balance = ${newBalance}, status = ${newStatus} WHERE id = ${item.transactionId}`;

        // Record payment application
        await sql`
          INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
          VALUES (${paymentId}, ${item.transactionId}, ${appliedAmount})
        `;

        console.log(`[API] Applied ${appliedAmount} to invoice ${invoice[0].reference}, new balance: ${newBalance}`);
      }

      // Handle unapplied credit
      if (unappliedAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${arAccount.id}, ${paymentId}, ${`Unapplied credit`}, 0, ${unappliedAmount}, ${paymentDate})
        `;
      }

      // Update account balances
      // Bank (asset) - debits increase
      await sql`UPDATE accounts SET balance = balance + ${paymentAmount} WHERE id = ${bankAccount.id}`;
      // AR (asset) - credits decrease
      const arDecreaseAmount = totalApplied + unappliedAmount;
      if (arDecreaseAmount > 0) {
        await sql`UPDATE accounts SET balance = balance - ${arDecreaseAmount} WHERE id = ${arAccount.id}`;
      }

      console.log('[API] Payment created:', paymentId);
      return res.status(201).json({ id: paymentId, success: true });
    }

    // Pay bills (vendor payment)
    if ((path === '/api/payments/pay-bills' || path.endsWith('/pay-bills')) && req.method === 'POST') {
      const data = req.body;
      const bills = data.bills || [];
      const paymentAmount = Number(data.amount) || bills.reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);

      console.log('[API] Processing bill payment:', { amount: paymentAmount, bills: bills.length });

      // Create the bill payment transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('bill_payment', ${data.reference}, ${data.date}, ${data.vendorId || data.contactId}, ${paymentAmount}, 0, ${data.currency || 'CAD'}, 'completed', ${data.memo || 'Bill payment'})
        RETURNING id
      `;

      const paymentId = result[0].id;
      const paymentDate = data.date;

      // Helper to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type
        `;
        return newAccount[0];
      };

      // Get required accounts
      const bankAccount = data.bankAccountId
        ? (await sql`SELECT id, type FROM accounts WHERE id = ${data.bankAccountId} LIMIT 1`)[0]
        : await getOrCreateAccount('1000', 'Cash', 'bank', 'Cash on hand');
      const apAccount = await getOrCreateAccount('2000', 'Accounts Payable', 'accounts_payable', 'Money owed to vendors');

      // Debit AP (decrease liability)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${apAccount.id}, ${paymentId}, ${`Bill payment ${data.reference || ''}`}, ${paymentAmount}, 0, ${paymentDate})
      `;

      // Credit bank (decrease cash)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${bankAccount.id}, ${paymentId}, ${`Bill payment ${data.reference || ''}`}, 0, ${paymentAmount}, ${paymentDate})
      `;

      // Process each bill
      for (const bill of bills) {
        if (!bill.billId && !bill.transactionId) continue;
        const billId = bill.billId || bill.transactionId;
        const appliedAmount = Number(bill.amount) || 0;

        // Get the bill
        const billTx = await sql`SELECT id, reference, balance, amount FROM transactions WHERE id = ${billId} LIMIT 1`;
        if (billTx.length === 0) continue;

        // Update bill balance and status
        const currentBalance = Number(billTx[0].balance) || Number(billTx[0].amount);
        const newBalance = Math.max(0, currentBalance - appliedAmount);
        const newStatus = newBalance <= 0 ? 'paid' : 'partial';

        await sql`UPDATE transactions SET balance = ${newBalance}, status = ${newStatus} WHERE id = ${billId}`;

        // Record payment application
        await sql`
          INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
          VALUES (${paymentId}, ${billId}, ${appliedAmount})
        `;

        console.log(`[API] Applied ${appliedAmount} to bill ${billTx[0].reference}, new balance: ${newBalance}`);
      }

      // Update account balances
      // AP (liability) - debits decrease
      await sql`UPDATE accounts SET balance = balance - ${paymentAmount} WHERE id = ${apAccount.id}`;
      // Bank (asset) - credits decrease
      await sql`UPDATE accounts SET balance = balance - ${paymentAmount} WHERE id = ${bankAccount.id}`;

      console.log('[API] Bill payment created:', paymentId);
      return res.status(201).json({ id: paymentId, success: true });
    }

    // Create expense
    if ((path === '/api/expenses' || path.endsWith('/expenses')) && req.method === 'POST') {
      const data = req.body;
      const lineItems = data.lineItems || [];

      // Calculate amounts
      const subTotal = Number(data.subTotal) || lineItems.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
      const taxAmount = Number(data.taxAmount) || 0;
      const totalAmount = Number(data.totalAmount) || (subTotal + taxAmount);

      console.log('[API] Creating expense:', { totalAmount, subTotal, taxAmount });

      // Create the expense transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo, sub_total, tax_amount)
        VALUES ('expense', ${data.reference}, ${data.date}, ${data.contactId || null}, ${totalAmount}, 0, ${data.currency || 'CAD'}, 'completed', ${data.description || data.memo || ''}, ${subTotal}, ${taxAmount})
        RETURNING id
      `;

      const transactionId = result[0].id;
      const expenseDate = data.date;
      const expenseRef = data.reference || `EXP-${transactionId}`;

      // Insert line items
      for (const item of lineItems) {
        await sql`
          INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, account_id, sales_tax_id)
          VALUES (${transactionId}, ${item.description}, 1, ${item.amount || 0}, ${item.amount || 0}, ${item.accountId || null}, ${item.salesTaxId || null})
        `;
      }

      // Helper to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type
        `;
        return newAccount[0];
      };

      // Get payment account
      const paymentAccount = data.paymentAccountId
        ? (await sql`SELECT id, type FROM accounts WHERE id = ${data.paymentAccountId} LIMIT 1`)[0]
        : await getOrCreateAccount('1000', 'Cash', 'bank', 'Cash on hand');

      // Get tax account
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liabilities', 'Tax collected on sales');

      // Create ledger entries for each line item (debit expense accounts)
      for (const item of lineItems) {
        if (item.accountId) {
          const expAccount = await sql`SELECT id, type FROM accounts WHERE id = ${item.accountId} LIMIT 1`;
          if (expAccount.length > 0) {
            await sql`
              INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
              VALUES (${item.accountId}, ${transactionId}, ${item.description || `Expense ${expenseRef}`}, ${item.amount || 0}, 0, ${expenseDate})
            `;
            // Update expense account balance (debit increases expense)
            await sql`UPDATE accounts SET balance = balance + ${item.amount || 0} WHERE id = ${item.accountId}`;
          }
        }
      }

      // Debit tax payable for input tax credit (reduces liability)
      if (taxAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxPayableAccount.id}, ${transactionId}, ${`Expense ${expenseRef} - Tax`}, ${taxAmount}, 0, ${expenseDate})
        `;
        await sql`UPDATE accounts SET balance = balance - ${taxAmount} WHERE id = ${taxPayableAccount.id}`;
      }

      // Credit payment account (decrease cash/bank)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${paymentAccount.id}, ${transactionId}, ${`Expense ${expenseRef}`}, 0, ${totalAmount}, ${expenseDate})
      `;
      await sql`UPDATE accounts SET balance = balance - ${totalAmount} WHERE id = ${paymentAccount.id}`;

      console.log('[API] Expense created:', transactionId);
      return res.status(201).json({ id: transactionId, success: true });
    }

    // Create deposit
    if ((path === '/api/deposits' || path.endsWith('/deposits')) && req.method === 'POST') {
      const data = req.body;
      const depositAmount = Number(data.amount) || 0;

      console.log('[API] Creating deposit:', { amount: depositAmount });

      // Determine status based on whether it's a customer deposit
      const status = data.contactId ? 'unapplied_credit' : 'completed';
      const balance = data.contactId ? -depositAmount : 0; // Negative balance for customer credits

      // Create the deposit transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('deposit', ${data.reference}, ${data.date}, ${data.contactId || null}, ${depositAmount}, ${balance}, ${data.currency || 'CAD'}, ${status}, ${data.description || ''})
        RETURNING id
      `;

      const transactionId = result[0].id;
      const depositDate = data.date;
      const depositRef = data.reference || `DEP-${transactionId}`;

      // Helper to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type
        `;
        return newAccount[0];
      };

      // Get accounts
      const bankAccount = data.depositAccountId
        ? (await sql`SELECT id, type FROM accounts WHERE id = ${data.depositAccountId} LIMIT 1`)[0]
        : await getOrCreateAccount('1000', 'Cash', 'bank', 'Cash on hand');

      const sourceAccount = data.sourceAccountId
        ? (await sql`SELECT id, type FROM accounts WHERE id = ${data.sourceAccountId} LIMIT 1`)[0]
        : (data.contactId
            ? await getOrCreateAccount('1100', 'Accounts Receivable', 'accounts_receivable', 'Money owed by customers')
            : await getOrCreateAccount('4100', 'Other Income', 'other_income', 'Other income'));

      // Create ledger entries
      // Debit bank account (increase cash)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${bankAccount.id}, ${transactionId}, ${`Deposit ${depositRef}`}, ${depositAmount}, 0, ${depositDate})
      `;

      // Credit source account
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${sourceAccount.id}, ${transactionId}, ${`Deposit ${depositRef}`}, 0, ${depositAmount}, ${depositDate})
      `;

      // Update account balances
      await sql`UPDATE accounts SET balance = balance + ${depositAmount} WHERE id = ${bankAccount.id}`;

      // Source account balance update depends on type
      const sourceType = sourceAccount.type;
      if (sourceType === 'accounts_receivable') {
        // AR is asset - credits decrease
        await sql`UPDATE accounts SET balance = balance - ${depositAmount} WHERE id = ${sourceAccount.id}`;
      } else {
        // Income accounts - credits increase
        await sql`UPDATE accounts SET balance = balance + ${depositAmount} WHERE id = ${sourceAccount.id}`;
      }

      console.log('[API] Deposit created:', transactionId);
      return res.status(201).json({ id: transactionId, success: true });
    }

    // Create journal entry
    if ((path === '/api/journal-entries' || path.endsWith('/journal-entries')) && req.method === 'POST') {
      const data = req.body;
      const entries = data.entries || [];

      // Calculate totals
      const totalDebits = entries.reduce((sum: number, e: any) => sum + (Number(e.debit) || 0), 0);
      const totalCredits = entries.reduce((sum: number, e: any) => sum + (Number(e.credit) || 0), 0);

      console.log('[API] Creating journal entry:', { totalDebits, totalCredits, entries: entries.length });

      // Validate debits = credits
      if (Math.abs(totalDebits - totalCredits) >= 0.01) {
        return res.status(400).json({ message: 'Total debits must equal total credits' });
      }

      // Create the journal entry transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo)
        VALUES ('journal_entry', ${data.reference}, ${data.date}, ${data.contactId || null}, ${totalDebits}, 0, ${data.currency || 'CAD'}, 'completed', ${data.description || ''})
        RETURNING id
      `;

      const transactionId = result[0].id;
      const entryDate = data.date;

      // Create ledger entries and update balances
      for (const entry of entries) {
        if (!entry.accountId) continue;

        const debit = Number(entry.debit) || 0;
        const credit = Number(entry.credit) || 0;

        // Insert ledger entry
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${entry.accountId}, ${transactionId}, ${entry.description || data.description || ''}, ${debit}, ${credit}, ${entryDate})
        `;

        // Get account type to determine balance update
        const account = await sql`SELECT id, type FROM accounts WHERE id = ${entry.accountId} LIMIT 1`;
        if (account.length > 0) {
          const accountType = account[0].type;
          let balanceChange = 0;

          // Debit-normal accounts: assets, expenses
          if (['bank', 'accounts_receivable', 'current_assets', 'fixed_asset', 'other_current_asset', 'expenses', 'cost_of_goods_sold', 'other_expense'].includes(accountType)) {
            balanceChange = debit - credit;
          } else {
            // Credit-normal accounts: liabilities, equity, income
            balanceChange = credit - debit;
          }

          if (balanceChange !== 0) {
            await sql`UPDATE accounts SET balance = balance + ${balanceChange} WHERE id = ${entry.accountId}`;
          }
        }
      }

      console.log('[API] Journal entry created:', transactionId);
      return res.status(201).json({ id: transactionId, success: true });
    }

    // Create transfer (between accounts)
    if ((path === '/api/transfers' || path.endsWith('/transfers')) && req.method === 'POST') {
      const { fromAccountId, toAccountId, amount, date, memo, reference } = req.body;
      const transferAmount = Number(amount) || 0;

      console.log('[API] Creating transfer:', { from: fromAccountId, to: toAccountId, amount: transferAmount });

      if (!fromAccountId || !toAccountId || !transferAmount) {
        return res.status(400).json({ message: 'fromAccountId, toAccountId, and amount are required' });
      }

      if (fromAccountId === toAccountId) {
        return res.status(400).json({ message: 'From and To accounts must be different' });
      }

      // Get accounts
      const fromAccount = await sql`SELECT id, name, type FROM accounts WHERE id = ${fromAccountId} LIMIT 1`;
      const toAccount = await sql`SELECT id, name, type FROM accounts WHERE id = ${toAccountId} LIMIT 1`;

      if (fromAccount.length === 0 || toAccount.length === 0) {
        return res.status(400).json({ message: 'One or both accounts not found' });
      }

      // Create the transfer transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, amount, balance, currency, status, memo)
        VALUES ('transfer', ${reference || null}, ${date}, ${transferAmount}, 0, 'CAD', 'completed', ${memo || `Transfer from ${fromAccount[0].name} to ${toAccount[0].name}`})
        RETURNING id
      `;

      const transactionId = result[0].id;

      // Create ledger entries
      // Debit to account (increase)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${toAccountId}, ${transactionId}, ${`Transfer from ${fromAccount[0].name}`}, ${transferAmount}, 0, ${date})
      `;

      // Credit from account (decrease)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${fromAccountId}, ${transactionId}, ${`Transfer to ${toAccount[0].name}`}, 0, ${transferAmount}, ${date})
      `;

      // Update account balances based on account types
      // For asset accounts (bank): debit increases, credit decreases
      const fromType = fromAccount[0].type;
      const toType = toAccount[0].type;

      // Update from account (credit)
      if (['bank', 'accounts_receivable', 'current_assets', 'fixed_asset', 'other_current_asset'].includes(fromType)) {
        await sql`UPDATE accounts SET balance = balance - ${transferAmount} WHERE id = ${fromAccountId}`;
      } else {
        await sql`UPDATE accounts SET balance = balance + ${transferAmount} WHERE id = ${fromAccountId}`;
      }

      // Update to account (debit)
      if (['bank', 'accounts_receivable', 'current_assets', 'fixed_asset', 'other_current_asset'].includes(toType)) {
        await sql`UPDATE accounts SET balance = balance + ${transferAmount} WHERE id = ${toAccountId}`;
      } else {
        await sql`UPDATE accounts SET balance = balance - ${transferAmount} WHERE id = ${toAccountId}`;
      }

      console.log('[API] Transfer created:', transactionId);
      return res.status(201).json({ id: transactionId, success: true });
    }

    // Create sales receipt (cash sale - immediate payment)
    if ((path === '/api/sales-receipts' || path.endsWith('/sales-receipts')) && req.method === 'POST') {
      const data = req.body;
      const lineItems = data.lineItems || [];

      const subTotal = Number(data.subTotal) || lineItems.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
      const taxAmount = Number(data.taxAmount) || 0;
      const totalAmount = Number(data.totalAmount) || (subTotal + taxAmount);

      console.log('[API] Creating sales receipt:', { totalAmount, subTotal, taxAmount });

      // Create the sales receipt transaction
      const result = await sql`
        INSERT INTO transactions (type, reference, date, contact_id, amount, balance, currency, status, memo, sub_total, tax_amount)
        VALUES ('sales_receipt', ${data.reference}, ${data.date}, ${data.contactId || null}, ${totalAmount}, 0, ${data.currency || 'CAD'}, 'completed', ${data.memo || ''}, ${subTotal}, ${taxAmount})
        RETURNING id
      `;

      const transactionId = result[0].id;
      const receiptDate = data.date;
      const receiptRef = data.reference || `SR-${transactionId}`;

      // Insert line items
      for (const item of lineItems) {
        await sql`
          INSERT INTO line_items (transaction_id, description, quantity, unit_price, amount, sales_tax_id, product_id)
          VALUES (${transactionId}, ${item.description}, ${item.quantity || 1}, ${item.unitPrice || 0}, ${item.amount || 0}, ${item.salesTaxId || null}, ${item.productId || null})
        `;
      }

      // Helper to get or create account
      const getOrCreateAccount = async (code: string, name: string, type: string, description: string) => {
        let account = await sql`SELECT id, type FROM accounts WHERE code = ${code} LIMIT 1`;
        if (account.length > 0) {
          if (account[0].type !== type) {
            await sql`UPDATE accounts SET type = ${type} WHERE id = ${account[0].id}`;
          }
          return account[0];
        }
        const newAccount = await sql`
          INSERT INTO accounts (code, name, type, description, balance, currency, is_active)
          VALUES (${code}, ${name}, ${type}, ${description}, 0, 'CAD', true)
          RETURNING id, type
        `;
        return newAccount[0];
      };

      // Get accounts
      const bankAccount = data.depositAccountId
        ? (await sql`SELECT id FROM accounts WHERE id = ${data.depositAccountId} LIMIT 1`)[0]
        : await getOrCreateAccount('1000', 'Cash', 'bank', 'Cash on hand');
      const revenueAccount = await getOrCreateAccount('4000', 'Service Revenue', 'income', 'Revenue from services');
      const taxPayableAccount = await getOrCreateAccount('2100', 'Sales Tax Payable', 'other_current_liabilities', 'Tax collected');

      // Create ledger entries
      // Debit bank (increase cash)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${bankAccount.id}, ${transactionId}, ${`Sales Receipt ${receiptRef}`}, ${totalAmount}, 0, ${receiptDate})
      `;

      // Credit revenue (increase income)
      await sql`
        INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
        VALUES (${revenueAccount.id}, ${transactionId}, ${`Sales Receipt ${receiptRef} - Revenue`}, 0, ${subTotal}, ${receiptDate})
      `;

      // Credit tax payable (if any)
      if (taxAmount > 0) {
        await sql`
          INSERT INTO ledger_entries (account_id, transaction_id, description, debit, credit, date)
          VALUES (${taxPayableAccount.id}, ${transactionId}, ${`Sales Receipt ${receiptRef} - Tax`}, 0, ${taxAmount}, ${receiptDate})
        `;
      }

      // Update account balances
      await sql`UPDATE accounts SET balance = balance + ${totalAmount} WHERE id = ${bankAccount.id}`;
      await sql`UPDATE accounts SET balance = balance + ${subTotal} WHERE id = ${revenueAccount.id}`;
      if (taxAmount > 0) {
        await sql`UPDATE accounts SET balance = balance + ${taxAmount} WHERE id = ${taxPayableAccount.id}`;
      }

      console.log('[API] Sales receipt created:', transactionId);
      return res.status(201).json({ id: transactionId, success: true });
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

    // ============================================
    // PRODUCT CRUD
    // ============================================

    // Create product
    if ((path === '/api/products' || path.endsWith('/products')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO products (name, sku, description, price, cost, income_account_id, expense_account_id, is_active)
        VALUES (${data.name}, ${data.sku || null}, ${data.description || ''}, ${data.price || 0}, ${data.cost || 0}, ${data.incomeAccountId || null}, ${data.expenseAccountId || null}, true)
        RETURNING *
      `;
      return res.status(201).json(transformKeys(result[0]));
    }

    // Update product
    const updateProductMatch = path.match(/\/api\/products\/(\d+)$/);
    if (updateProductMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
      const productId = parseInt(updateProductMatch[1]);
      const data = req.body;
      const result = await sql`
        UPDATE products SET
          name = COALESCE(${data.name}, name),
          sku = COALESCE(${data.sku}, sku),
          description = COALESCE(${data.description}, description),
          price = COALESCE(${data.price}, price),
          cost = COALESCE(${data.cost}, cost),
          income_account_id = COALESCE(${data.incomeAccountId}, income_account_id),
          expense_account_id = COALESCE(${data.expenseAccountId}, expense_account_id),
          is_active = COALESCE(${data.isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${productId}
        RETURNING *
      `;
      if (result.length === 0) {
        return res.status(404).json({ message: 'Product not found' });
      }
      return res.status(200).json(transformKeys(result[0]));
    }

    // Delete product
    if (updateProductMatch && req.method === 'DELETE') {
      const productId = parseInt(updateProductMatch[1]);
      await sql`UPDATE products SET is_active = false WHERE id = ${productId}`;
      return res.status(200).json({ success: true });
    }

    // ============================================
    // SALES TAX CRUD
    // ============================================

    // Create sales tax
    if ((path === '/api/sales-taxes' || path.endsWith('/sales-taxes')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO sales_taxes (name, rate, description, is_active)
        VALUES (${data.name}, ${data.rate}, ${data.description || ''}, true)
        RETURNING *
      `;
      return res.status(201).json(transformKeys(result[0]));
    }

    // Update sales tax
    const updateSalesTaxMatch = path.match(/\/api\/sales-taxes\/(\d+)$/);
    if (updateSalesTaxMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
      const taxId = parseInt(updateSalesTaxMatch[1]);
      const data = req.body;
      const result = await sql`
        UPDATE sales_taxes SET
          name = COALESCE(${data.name}, name),
          rate = COALESCE(${data.rate}, rate),
          description = COALESCE(${data.description}, description),
          is_active = COALESCE(${data.isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${taxId}
        RETURNING *
      `;
      if (result.length === 0) {
        return res.status(404).json({ message: 'Sales tax not found' });
      }
      return res.status(200).json(transformKeys(result[0]));
    }

    // Delete sales tax
    if (updateSalesTaxMatch && req.method === 'DELETE') {
      const taxId = parseInt(updateSalesTaxMatch[1]);
      await sql`UPDATE sales_taxes SET is_active = false WHERE id = ${taxId}`;
      return res.status(200).json({ success: true });
    }

    // ============================================
    // RECURRING TRANSACTION CRUD
    // ============================================

    // Create recurring transaction
    if ((path === '/api/recurring' || path.endsWith('/recurring')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO recurring_transactions (name, type, frequency, next_date, contact_id, amount, account_id, is_active)
        VALUES (${data.name}, ${data.type}, ${data.frequency}, ${data.nextDate}, ${data.contactId || null}, ${data.amount || 0}, ${data.accountId || null}, true)
        RETURNING *
      `;
      return res.status(201).json(transformKeys(result[0]));
    }

    // Update recurring transaction
    const updateRecurringMatch = path.match(/\/api\/recurring\/(\d+)$/);
    if (updateRecurringMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
      const recurringId = parseInt(updateRecurringMatch[1]);
      const data = req.body;
      const result = await sql`
        UPDATE recurring_transactions SET
          name = COALESCE(${data.name}, name),
          type = COALESCE(${data.type}, type),
          frequency = COALESCE(${data.frequency}, frequency),
          next_date = COALESCE(${data.nextDate}, next_date),
          contact_id = COALESCE(${data.contactId}, contact_id),
          amount = COALESCE(${data.amount}, amount),
          account_id = COALESCE(${data.accountId}, account_id),
          is_active = COALESCE(${data.isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${recurringId}
        RETURNING *
      `;
      if (result.length === 0) {
        return res.status(404).json({ message: 'Recurring transaction not found' });
      }
      return res.status(200).json(transformKeys(result[0]));
    }

    // Delete recurring transaction
    if (updateRecurringMatch && req.method === 'DELETE') {
      const recurringId = parseInt(updateRecurringMatch[1]);
      await sql`UPDATE recurring_transactions SET is_active = false WHERE id = ${recurringId}`;
      return res.status(200).json({ success: true });
    }

    // Pause recurring transaction
    const pauseRecurringMatch = path.match(/\/api\/recurring\/(\d+)\/pause$/);
    if (pauseRecurringMatch && req.method === 'POST') {
      const recurringId = parseInt(pauseRecurringMatch[1]);
      await sql`UPDATE recurring_transactions SET is_active = false WHERE id = ${recurringId}`;
      return res.status(200).json({ success: true });
    }

    // Resume recurring transaction
    const resumeRecurringMatch = path.match(/\/api\/recurring\/(\d+)\/resume$/);
    if (resumeRecurringMatch && req.method === 'POST') {
      const recurringId = parseInt(resumeRecurringMatch[1]);
      await sql`UPDATE recurring_transactions SET is_active = true WHERE id = ${recurringId}`;
      return res.status(200).json({ success: true });
    }

    // ============================================
    // CATEGORIZATION RULES CRUD
    // ============================================

    // Get single categorization rule
    const categorizationRuleIdMatch = path.match(/\/api\/categorization-rules\/(\d+)$/);
    if (categorizationRuleIdMatch && req.method === 'GET') {
      const ruleId = parseInt(categorizationRuleIdMatch[1]);
      const rules = await sql`SELECT * FROM categorization_rules WHERE id = ${ruleId}`;
      if (rules.length === 0) {
        return res.status(404).json({ message: 'Categorization rule not found' });
      }
      return res.status(200).json(transformKeys(rules[0]));
    }

    // Create categorization rule
    if ((path === '/api/categorization-rules' || path.endsWith('/categorization-rules')) && req.method === 'POST') {
      const data = req.body;
      const result = await sql`
        INSERT INTO categorization_rules (name, pattern, account_id, is_active)
        VALUES (${data.name}, ${data.pattern}, ${data.accountId}, true)
        RETURNING *
      `;
      return res.status(201).json(transformKeys(result[0]));
    }

    // Update categorization rule
    if (categorizationRuleIdMatch && req.method === 'PATCH') {
      const ruleId = parseInt(categorizationRuleIdMatch[1]);
      const data = req.body;
      const result = await sql`
        UPDATE categorization_rules SET
          name = COALESCE(${data.name}, name),
          pattern = COALESCE(${data.pattern}, pattern),
          account_id = COALESCE(${data.accountId}, account_id),
          is_active = COALESCE(${data.isActive}, is_active),
          updated_at = NOW()
        WHERE id = ${ruleId}
        RETURNING *
      `;
      if (result.length === 0) {
        return res.status(404).json({ message: 'Categorization rule not found' });
      }
      return res.status(200).json(transformKeys(result[0]));
    }

    // Delete categorization rule
    if (categorizationRuleIdMatch && req.method === 'DELETE') {
      const ruleId = parseInt(categorizationRuleIdMatch[1]);
      await sql`DELETE FROM categorization_rules WHERE id = ${ruleId}`;
      return res.status(200).json({ success: true });
    }

    // ============================================
    // EXCHANGE RATE CRUD
    // ============================================

    // Get single exchange rate
    const exchangeRateIdMatch = path.match(/\/api\/exchange-rates\/(\d+)$/);
    if (exchangeRateIdMatch && req.method === 'GET') {
      const rateId = parseInt(exchangeRateIdMatch[1]);
      const rates = await sql`SELECT * FROM exchange_rates WHERE id = ${rateId}`;
      if (rates.length === 0) {
        return res.status(404).json({ message: 'Exchange rate not found' });
      }
      return res.status(200).json(transformKeys(rates[0]));
    }

    // Delete exchange rate
    if (exchangeRateIdMatch && req.method === 'DELETE') {
      const rateId = parseInt(exchangeRateIdMatch[1]);
      await sql`DELETE FROM exchange_rates WHERE id = ${rateId}`;
      return res.status(200).json({ success: true });
    }

    return res.status(404).json({
      message: 'Endpoint not found',
      path,
      url: req.url,
      method: req.method,
      _path: req.query._path,
      query: req.query
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({
      message: 'Server error',
      error: error.message,
      path
    });
  }
}
