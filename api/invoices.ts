import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function transformKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(transformKeys);
  if (obj instanceof Date) return obj.toISOString();
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      acc[toCamelCase(key)] = value instanceof Date ? value.toISOString() : transformKeys(value);
      return acc;
    }, {} as any);
  }
  return obj;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ message: 'DATABASE_URL not configured' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET - List invoices
    if (req.method === 'GET') {
      const invoices = await sql`
        SELECT t.*, c.name as contact_name
        FROM transactions t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.type = 'invoice'
        ORDER BY t.date DESC
      `;
      return res.status(200).json(transformKeys(invoices));
    }

    // POST - Create invoice
    if (req.method === 'POST') {
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

    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
}
