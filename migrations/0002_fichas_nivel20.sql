-- Solo si ya habías creado la base con la versión anterior (sin fichas de Nivel20).
-- Uso: npm run db:migrate
ALTER TABLE players ADD COLUMN sheet TEXT NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN sheet_url TEXT NOT NULL DEFAULT '';
