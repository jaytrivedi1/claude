import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// Convert snake_case to camelCase
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Transform object keys from snake_case to camelCase
function transformKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(transformKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      acc[toCamelCase(key)] = transformKeys(obj[key]);
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

      return res.status(200).json({
        ...userWithoutPassword,
        companies: userCompanies
      });
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
      return res.status(200).json(userWithoutPassword);
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
      return res.status(200).json(companies);
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
      return res.status(200).json(companies[0]);
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
    if ((path === '/api/preferences' || path.endsWith('/preferences')) && req.method === 'GET') {
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
      return res.status(200).json(transformKeys(accounts));
    }

    // Get products
    if ((path === '/api/products' || path.endsWith('/products')) && req.method === 'GET') {
      const products = await sql`SELECT * FROM products WHERE is_active = true ORDER BY name`;
      return res.status(200).json(transformKeys(products));
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
