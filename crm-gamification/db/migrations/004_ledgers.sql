-- Libros durables de fidelidad (XP) y monedas. Las tablas existen desde 001_init.sql; aquí se agregan
-- las columnas que el servicio necesita para reconstruir el saldo (temporada, asiento compensado e id
-- del asiento) y un índice para seguir los asientos nuevos de otra réplica por id creciente.

ALTER TABLE loyalty_ledger ADD COLUMN IF NOT EXISTS entry_id    text;
ALTER TABLE loyalty_ledger ADD COLUMN IF NOT EXISTS season      text NOT NULL DEFAULT '';
ALTER TABLE loyalty_ledger ADD COLUMN IF NOT EXISTS compensates text;
CREATE INDEX IF NOT EXISTS loyalty_ledger_seq ON loyalty_ledger (tenant_id, id);
CREATE INDEX IF NOT EXISTS coin_ledger_seq ON coin_ledger (tenant_id, id);
