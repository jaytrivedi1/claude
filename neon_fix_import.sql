-- Vedo Bookkeeping - CORRECTED Neon Data Import
-- Run this in Neon SQL Editor to fix missing data
-- This fixes column name mismatches from original import

-- 1. Clear and re-import sales_taxes with correct column names
DELETE FROM sales_taxes;

INSERT INTO sales_taxes (id, name, description, rate, account_id, is_active, is_composite, parent_id, display_order) VALUES
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

-- 2. Clear and re-import products with correct column names
DELETE FROM products;

INSERT INTO products (id, name, description, sku, type, price, cost, account_id, sales_tax_id, is_active, created_at, updated_at) VALUES
(8, 'Bookkeeping', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:08.227863', '2025-04-14 14:52:08.227863'),
(9, 'Year-End Accounting', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:21.390283', '2025-04-14 14:52:21.390283'),
(10, 'Corporate Tax Return (T2)', '', NULL, 'product', 0.00, 0.00, 10, NULL, true, '2025-04-14 14:52:48.166739', '2025-04-14 14:52:48.166739');

-- Reset products sequence
SELECT setval('products_id_seq', (SELECT MAX(id) FROM products));

-- 3. Clear and re-import contacts with correct column names (no balance/custom_fields)
DELETE FROM contacts;

INSERT INTO contacts (id, name, contact_name, email, phone, address, type, currency, is_active) VALUES
(2, 'Tech Supplies Inc.', 'Jane Doe', 'jane@techsupplies.example', '555-987-6543', '456 Vendor St, Supplier Town, 54321', 'vendor', 'USD', true),
(4, 'Splendid Support Inc.', 'Mr. Joe Splendid', 'joe@splendidsupport.com', '4161237890', '', 'customer', 'CAD', true),
(5, 'ABC Enterprise Inc.', 'Mr. ABC', 'abc@abc.com', '4161234567', E'123, ABC Road\nOakville\nON', 'customer', 'CAD', true),
(6, 'The Customer Company', 'Mr. Customer', 'customer@company.example', '789-456-1230', E'111, The Customer Street\nCustomer City, ON L5J 1S6', 'customer', 'CAD', true),
(7, 'Super Supplier Inc.', 'Joseph Super', 'jsuper@supers.com', '905-123-4567', E'123 Super Street,\nSuper City\nON A1A 1A1', 'vendor', 'CAD', true),
(8, 'Tropical Smoothie Cafe', '', 'trp@cafe.com', '', '', 'vendor', 'CAD', true),
(11, 'USA Client Inc.', '', '', '', NULL, 'customer', 'USD', true),
(12, 'USA Vendor Inc.', '', '', '', NULL, 'vendor', 'USD', true),
(13, 'Europe Customer Inc.', '', '', '', NULL, 'customer', 'EUR', true);

-- Reset contacts sequence
SELECT setval('contacts_id_seq', (SELECT MAX(id) FROM contacts));

-- Verify counts
SELECT 'sales_taxes' as table_name, COUNT(*) as count FROM sales_taxes
UNION ALL
SELECT 'products', COUNT(*) FROM products
UNION ALL
SELECT 'contacts', COUNT(*) FROM contacts;
