-- Vedo Bookkeeping - Neon Data Import Part 2
-- Run this in Neon SQL Editor AFTER Part 1
-- This imports: transactions, line_items

-- transactions (22 rows)
INSERT INTO transactions (id, number, type, date, description, amount, contact_id, status, balance, subtotal, tax_amount, payment_method, account_id, payment_date, notes, due_date, invoice_id, payment_id, credit_id, currency, exchange_rate, bill_id) VALUES
(254, 'A-101', 'bill', '2025-09-15 04:00:00', '', 315, 7, 'open', 315, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(270, 'EXP-2025-1002', 'expense', '2025-10-02 15:49:11.279', '', 574.87, 2, 'completed', NULL, 500, 74.87, NULL, 22, '2025-10-02 15:49:11.279', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(272, '', 'expense', '2024-11-08 05:00:00', '', 220, 2, 'completed', NULL, 200, 20, 'bank_transfer', 1, '2024-11-08 05:00:00', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(304, 'BILL-0003', 'bill', '2025-10-01 04:00:00', '', 2260, 2, 'open', 2260, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(305, 'BILL-0004', 'bill', '2025-10-06 04:00:00', '', 1695, 2, 'open', 1695, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(306, 'CHQ-1001', 'cheque', '2025-10-10 04:00:00', '', 3000, 2, 'unapplied_credit', -3000, 3000, 0, 'check', 22, '2025-10-10 04:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(316, 'DEP-2025-10-21', 'deposit', '2025-10-21 19:23:26.048', 'Deposit', 378, NULL, 'completed', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(319, '', 'expense', '2025-10-14 00:00:00', 'Misc Payment Wise', 299.97, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-10-14 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(320, '', 'expense', '2025-10-14 00:00:00', 'COMMERCIAL TAXES EMPTX 6432635', 1, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-10-14 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(321, 'TRF-2025-1023-1673', 'journal_entry', '2025-10-23 18:59:00.034', 'Transfer from RBC Bank 0123 to Cash', 1000, NULL, 'completed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(323, 'SR-2025-1027-2777', 'journal_entry', '2025-10-27 21:43:12.777', 'Sales Receipt SR-2025-1027-2777', 2100, 5, 'completed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(325, '', 'expense', '2025-09-02 00:00:00', 'Bill Payment PAY-FILE FEES', 4, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-09-02 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(326, '', 'expense', '2025-06-02 00:00:00', 'Bill Payment PAY-FILE FEES', 2, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-06-02 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(327, '', 'expense', '2025-08-01 00:00:00', 'Bill Payment PAY-FILE FEES', 2, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-08-01 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(328, '', 'expense', '2025-07-02 00:00:00', 'Bill Payment PAY-FILE FEES', 2, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-07-02 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(329, '', 'expense', '2025-10-01 00:00:00', 'Bill Payment PAY-FILE FEES', 2, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-10-01 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(330, '', 'expense', '2025-10-09 00:00:00', 'Direct Deposits (PDS) service total PAY EMP-VENDOR', 3, NULL, 'completed', NULL, NULL, NULL, NULL, 22, '2025-10-09 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(331, '123', 'expense', '2025-10-29 22:11:46.033', '', 1130, 2, 'completed', NULL, 1000, 130, NULL, 22, '2025-10-29 22:11:46.033', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(335, '', 'expense', '2025-10-28 04:00:00', '', 41.67, 8, 'completed', NULL, 36.88, 4.79, NULL, 22, '2025-10-28 04:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(344, NULL, 'expense', '2025-11-13 00:00:00', 'CASH APP TRANSFER', 30, NULL, 'completed', NULL, NULL, NULL, 'bank_transfer', 22, '2025-11-13 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(346, 'DEP-1764197132281', 'deposit', '2025-11-26 22:45:01.672', 'Deposit', 500, 4, 'unapplied_credit', -500, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
(348, NULL, 'deposit', '2025-11-19 05:00:00', 'Deposit Applied to invoice #1001 on 2025-11-28 [Credit restored after invoice #1001 deletion on 2025-11-28]', 500, 5, 'unapplied_credit', -500, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- Reset transactions sequence
SELECT setval('transactions_id_seq', (SELECT MAX(id) FROM transactions));

-- line_items (18 rows)
INSERT INTO line_items (id, transaction_id, description, quantity, unit_price, amount, tax_id, account_id, product_id) VALUES
(79, 254, '', 1, 300, 300, 1, 21, NULL),
(91, 270, '', 1, 500, 500, 8, 16, NULL),
(98, 272, '', 1, 200, 200, 4, 15, NULL),
(117, 304, '', 1, 2000, 2000, 4, 16, NULL),
(118, 305, '', 1, 1500, 1500, 4, 14, NULL),
(119, 306, '', 1, 3000, 3000, 6, 4, NULL),
(134, 319, 'Misc Payment Wise', 1, 265.46, 265.46, 4, 16, NULL),
(135, 320, 'COMMERCIAL TAXES EMPTX 6432635', 1, 1, 1, 5, 27, NULL),
(137, 323, 'Bookkeeping', 1, 2000, 2000, 1, NULL, 8),
(139, 328, 'Bill Payment PAY-FILE FEES', 1, 2, 2, 5, 27, NULL),
(140, 326, 'Bill Payment PAY-FILE FEES', 1, 2, 2, 5, 27, NULL),
(141, 327, 'Bill Payment PAY-FILE FEES', 1, 2, 2, 5, 27, NULL),
(142, 325, 'Bill Payment PAY-FILE FEES', 1, 4, 4, 5, 27, NULL),
(143, 329, 'Bill Payment PAY-FILE FEES', 1, 2, 2, 5, 27, NULL),
(144, 330, 'Direct Deposits (PDS) service total PAY EMP-VENDOR', 1, 3, 3, 6, 13, NULL),
(145, 331, '', 1, 1000, 1000, 4, 15, NULL),
(150, 335, '', 1, 41.67, 41.67, 4, 28, NULL),
(155, 344, 'CASH APP TRANSFER', 1, 30, 30, 5, 27, NULL);

-- Reset line_items sequence
SELECT setval('line_items_id_seq', (SELECT MAX(id) FROM line_items));

-- Verify data was imported
SELECT 'Accounts:' as table_name, COUNT(*) as count FROM accounts
UNION ALL
SELECT 'Contacts:', COUNT(*) FROM contacts
UNION ALL
SELECT 'Sales Taxes:', COUNT(*) FROM sales_taxes
UNION ALL
SELECT 'Products:', COUNT(*) FROM products
UNION ALL
SELECT 'Transactions:', COUNT(*) FROM transactions
UNION ALL
SELECT 'Line Items:', COUNT(*) FROM line_items;
