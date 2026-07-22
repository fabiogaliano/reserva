-- Operator-editable config overrides (see src/core/settings.ts). One row per overridden setting;
-- absence of a row means "follow the file config". Values are JSON-encoded.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
