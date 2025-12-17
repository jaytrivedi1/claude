import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

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
        ORDER BY uc.is_primary DESC, c.id ASC
        LIMIT 1
      `;
      if (companies.length === 0) {
        return res.status(404).json({ message: 'No company found' });
      }
      return res.status(200).json(companies[0]);
    }

    // Dashboard metrics
    if ((path === '/api/dashboard/metrics' || path.endsWith('/dashboard/metrics')) && req.method === 'GET') {
      // Return basic metrics
      const accountsResult = await sql`SELECT COUNT(*) as count FROM accounts`;
      const transactionsResult = await sql`SELECT COUNT(*) as count FROM transactions`;
      const contactsResult = await sql`SELECT COUNT(*) as count FROM contacts`;

      // Get totals
      const incomeResult = await sql`
        SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'invoice'
      `;
      const expenseResult = await sql`
        SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'
      `;

      return res.status(200).json({
        totalIncome: incomeResult[0]?.total || 0,
        totalExpenses: expenseResult[0]?.total || 0,
        accountsCount: accountsResult[0]?.count || 0,
        transactionsCount: transactionsResult[0]?.count || 0,
        contactsCount: contactsResult[0]?.count || 0,
        recentTransactions: []
      });
    }

    // Get accounts
    if ((path === '/api/accounts' || path.endsWith('/accounts')) && req.method === 'GET') {
      const accounts = await sql`SELECT * FROM accounts ORDER BY code, name`;
      return res.status(200).json(accounts);
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
      return res.status(200).json(transactions);
    }

    // Get contacts
    if ((path === '/api/contacts' || path.endsWith('/contacts')) && req.method === 'GET') {
      const contacts = await sql`SELECT * FROM contacts ORDER BY name`;
      return res.status(200).json(contacts);
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
