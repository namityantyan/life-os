-- Assets / cards: link statement lines to their statement; freee bookkeeping fields.
ALTER TABLE card_transactions ADD COLUMN statement_id TEXT;
CREATE INDEX IF NOT EXISTS idx_card_tx_statement ON card_transactions(statement_id);
ALTER TABLE card_statements ADD COLUMN csv_total REAL;
ALTER TABLE card_statements ADD COLUMN note TEXT;
