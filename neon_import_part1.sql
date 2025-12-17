-- Vedo Bookkeeping - Neon Data Import Part 1
-- Run this in Neon SQL Editor
-- This imports: accounts (Chart of Accounts), contacts, sales_taxes, products

-- First, clear existing data (to avoid duplicates)
DELETE FROM line_items;
DELETE FROM transactions;
DELETE FROM products;
DELETE FROM sales_taxes;
DELETE FROM contacts;
DELETE FROM accounts;
DELETE FROM preferences;

-- accounts (32 rows) - Chart of Accounts
INSERT INTO accounts (id, code, name, type, currency, description, balance, is_active, cash_flow_category) VALUES
(1, '1000', 'Cash', 'bank', 'CAD', '', 26, true, 'none'),
(2, '1100', 'Accounts Receivable', 'accounts_receivable', 'CAD', '', 81864.98, true, 'operating'),
(3, '1200', 'Inventory', 'current_assets', 'CAD', '', 3202, false, 'operating'),
(4, '2000', 'Accounts Payable', 'accounts_payable', 'CAD', '', -3192, true, 'operating'),
(5, '2100', 'Sales Tax Payable', 'other_current_liabilities', 'CAD', '', 257.33, true, 'operating'),
(6, '2200', 'Accrued Expenses', 'other_current_liabilities', 'CAD', '', 65, true, 'operating'),
(7, '3000', 'Owner''s Equity', 'equity', 'CAD', '', 0, true, 'financing'),
(8, '3100', 'Retained Earnings', 'equity', 'CAD', '', 0, true, 'financing'),
(9, '4000', 'Sales Revenue', 'income', 'CAD', '', 6378.60, true, 'operating'),
(10, '4100', 'Service Revenue', 'income', 'CAD', '', 1112.5, true, 'operating'),
(11, '4200', 'Interest Income', 'other_income', 'CAD', '', 0, true, 'operating'),
(12, '5000', 'Cost of Goods Sold', 'cost_of_goods_sold', 'CAD', '', 0, true, 'operating'),
(13, '5100', 'Salary Expense', 'expenses', 'CAD', '', -3, true, 'operating'),
(14, '5200', 'Rent Expense', 'expenses', 'CAD', '', -1500, true, 'operating'),
(15, '5300', 'Utilities Expense', 'expenses', 'CAD', '', -1000, true, 'operating'),
(16, '5400', 'Office Supplies', 'expenses', 'CAD', '', -2965.46, true, 'operating'),
(17, '1300', 'Office Building', 'current_assets', 'CAD', '', 0, true, 'investing'),
(19, '2300', 'Business Credit Card', 'current_assets', 'CAD', '', 0, true, 'none'),
(20, '2400', 'Long-term Loan', 'current_assets', 'CAD', '', 0, true, 'financing'),
(21, '5500', 'Miscellaneous Expenses', 'expenses', 'CAD', '', -300, true, 'operating'),
(22, '1050', 'RBC Bank 0123', 'bank', 'CAD', '', -88115.655, true, 'none'),
(23, '2500', 'Test Account', 'other_current_liabilities', 'USD', 'TEST', 0, true, 'none'),
(24, '2110', 'PST Payable', 'other_current_liabilities', 'CAD', '', 0, true, 'operating'),
(25, '2120', 'QST Payable', 'other_current_liabilities', 'CAD', '', -49.87, true, 'operating'),
(27, '5600', 'Bank charges', 'expenses', 'CAD', '', -33, true, 'operating'),
(28, '5700', 'Meals', 'expenses', 'CAD', '', -36.88, true, 'operating'),
(29, '5800', 'Advertising', 'expenses', 'CAD', '', 0, true, 'operating'),
(30, '4300', 'Realized FX Gain', 'other_income', 'USD', NULL, 0, true, 'operating'),
(31, '7100', 'Realized FX Loss', 'other_expense', 'USD', NULL, 0, true, 'operating'),
(32, '1110', 'Accounts Receivable - USD', 'accounts_receivable', 'USD', '', 0, true, 'none'),
(34, NULL, 'Accounts Payable - USD', 'accounts_payable', 'USD', NULL, 0, true, 'none'),
(35, NULL, 'Accounts Receivable - EUR', 'accounts_receivable', 'EUR', NULL, 1621.4, true, 'none');

-- Reset accounts sequence
SELECT setval('accounts_id_seq', (SELECT MAX(id) FROM accounts));

-- contacts (9 rows) - Customers and Vendors
INSERT INTO contacts (id, name, contact_name, email, phone, address, type, currency, balance, custom_fields, is_active) VALUES
(2, 'Tech Supplies Inc.', 'Jane Doe', 'jane@techsupplies.example', '555-987-6543', '456 Vendor St, Supplier Town, 54321', 'vendor', 'USD', 0, '{}', true),
(4, 'Splendid Support Inc.', 'Mr. Joe Splendid', 'joe@splendidsupport.com', '4161237890', '', 'customer', 'CAD', 0, '{}', true),
(5, 'ABC Enterprise Inc.', 'Mr. ABC', 'abc@abc.com', '4161234567', E'123, ABC Road\nOakville\nON', 'customer', 'CAD', 0, '{}', true),
(6, 'The Customer Company', 'Mr. Customer', 'customer@company.example', '789-456-1230', E'111, The Customer Street\nCustomer City, ON L5J 1S6', 'customer', 'CAD', 0, '{}', true),
(7, 'Super Supplier Inc.', 'Joseph Super', 'jsuper@supers.com', '905-123-4567', E'123 Super Street,\nSuper City\nON A1A 1A1', 'vendor', 'CAD', 0, '{}', true),
(8, 'Tropical Smoothie Cafe', '', 'trp@cafe.com', '', '', 'vendor', 'CAD', 0, '{}', true),
(11, 'USA Client Inc.', '', '', '', NULL, 'customer', 'USD', 0, '{}', true),
(12, 'USA Vendor Inc.', '', '', '', NULL, 'vendor', 'USD', 0, '{}', true),
(13, 'Europe Customer Inc.', '', '', '', NULL, 'customer', 'EUR', 0, '{}', true);

-- Reset contacts sequence
SELECT setval('contacts_id_seq', (SELECT MAX(id) FROM contacts));

-- sales_taxes (10 rows)
INSERT INTO sales_taxes (id, name, description, rate, account_id, is_active, is_compound, parent_id, sort_order) VALUES
(1, 'GST', 'Goods and Services Tax', 5, 5, true, false, NULL, 0),
(2, 'Sask PST', 'Saskatchewan Provincial Sales Tax', 12, NULL, true, true, NULL, 0),
(4, 'HST ON', 'Ontario Harmonized Sales Tax', 13, 5, true, false, NULL, 0),
(5, 'Exempt', '', 0, 5, true, false, NULL, 0),
(6, 'Out of Scope', '', 0, 5, true, false, NULL, 0),
(8, 'QST+GST', 'Quebec Sales Tax (9.975%) + Goods and Services Tax (5%)', 14.975, 5, true, true, NULL, 0),
(19, 'QST', 'Component of QST+GST', 9.975, 25, true, false, 8, 0),
(20, 'GST', 'Component of QST+GST', 5, 5, true, false, 8, 1),
(23, 'GST', 'Component of Sask PST', 5, 5, true, false, 2, 0),
(24, 'PST', 'Component of Sask PST', 7, 24, true, false, 2, 1);

-- Reset sales_taxes sequence
SELECT setval('sales_taxes_id_seq', (SELECT MAX(id) FROM sales_taxes));

-- products (3 rows)
INSERT INTO products (id, name, description, sku, type, sales_price, purchase_price, income_account_id, expense_account_id, is_active, created_at, updated_at) VALUES
(8, 'Bookkeeping', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:08.227863', '2025-04-14 14:52:08.227863'),
(9, 'Year-End Accounting', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:21.390283', '2025-04-14 14:52:21.390283'),
(10, 'Corporate Tax Return (T2)', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:48.166739', '2025-04-14 14:52:48.166739');

-- Reset products sequence
SELECT setval('products_id_seq', (SELECT MAX(id) FROM products));

-- preferences (1 row)
INSERT INTO preferences (id, email_reminders, show_dashboard_welcome, logo_url, updated_at, auto_sync_enabled, home_currency, created_at, theme, last_sync_at) VALUES
(1, false, true, NULL, '2025-11-26 19:03:03.382', true, 'CAD', '2025-11-06 21:35:47.921', 'classic', NULL);

-- Reset preferences sequence
SELECT setval('preferences_id_seq', 1);
