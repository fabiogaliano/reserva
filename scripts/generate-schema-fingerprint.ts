#!/usr/bin/env bun
// The runtime schema check runs inside a Cloudflare Worker, which has no filesystem and cannot read
// migrations/*.sql. Replaying the migration chain at build time into a plain TypeScript module is
// what lets the isolate-time check compare a live database against the real schema instead of
// against hand-maintained probes that drift every time a migration lands.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SchemaFingerprintTable {
  columns: string[];
  indexes: string[];
}

export interface SchemaFingerprint {
  migrations: string[];
  tables: Record<string, SchemaFingerprintTable>;
}

// Line comments only: reserva's migrations use `--`, and stripping block comments would need the
// same string-awareness for no benefit today.
function stripComments(sql: string): string {
  let output = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (inString) {
      output += character;
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      output += character;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    output += character;
  }
  return output;
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let depth = 0;
  for (const character of stripComments(sql)) {
    if (inString) {
      current += character;
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ';' && depth === 0) {
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((statement) => statement.length > 0);
}

function unquoteIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) return trimmed.slice(1, -1);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

// The parenthesised body of a CREATE TABLE, from its first top-level `(` to the matching `)`.
function tableBody(statement: string): string {
  const start = statement.indexOf('(');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  for (let index = start; index < statement.length; index += 1) {
    const character = statement[index]!;
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") { inString = true; continue; }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return statement.slice(start + 1, index);
    }
  }
  return statement.slice(start + 1);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (const character of body) {
    if (inString) {
      current += character;
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") { inString = true; current += character; continue; }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const TABLE_CONSTRAINT_KEYWORDS = ['primary', 'unique', 'check', 'foreign', 'constraint'];

function isTableConstraint(definition: string): boolean {
  const first = definition.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return TABLE_CONSTRAINT_KEYWORDS.includes(first);
}

function columnNameOf(definition: string): string | null {
  if (isTableConstraint(definition)) return null;
  const match = definition.trim().match(/^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)/);
  return match ? unquoteIdentifier(match[1]!) : null;
}

interface MutableTable {
  columns: string[];
  indexes: Set<string>;
}

// Replays the chain the way SQLite would: DROP TABLE takes the table's indexes with it, and
// RENAME TO carries them over — which is exactly what makes the rebuild-and-rename pattern in
// 0002 land on the same fingerprint as a freshly initialised database.
function applyStatement(tables: Map<string, MutableTable>, statement: string): void {
  const normalized = statement.replace(/\s+/g, ' ').trim();

  const createTable = normalized.match(/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (createTable) {
    const name = unquoteIdentifier(createTable[1]!);
    const columns = splitTopLevel(tableBody(statement))
      .map(columnNameOf)
      .filter((column): column is string => column !== null);
    tables.set(name, { columns, indexes: new Set() });
    return;
  }

  const createIndex = normalized.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$.]*)\s+ON\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (createIndex) {
    const indexName = unquoteIdentifier(createIndex[1]!).split('.').pop()!;
    const tableName = unquoteIdentifier(createIndex[2]!);
    tables.get(tableName)?.indexes.add(indexName);
    return;
  }

  const dropIndex = normalized.match(/^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$.]*)/i);
  if (dropIndex) {
    const indexName = unquoteIdentifier(dropIndex[1]!).split('.').pop()!;
    for (const table of tables.values()) table.indexes.delete(indexName);
    return;
  }

  const dropTable = normalized.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (dropTable) {
    tables.delete(unquoteIdentifier(dropTable[1]!));
    return;
  }

  const alter = normalized.match(/^ALTER\s+TABLE\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\s+(.*)$/i);
  if (!alter) return;
  const tableName = unquoteIdentifier(alter[1]!);
  const action = alter[2]!;
  const table = tables.get(tableName);

  const renameTo = action.match(/^RENAME\s+TO\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (renameTo) {
    if (table) {
      tables.delete(tableName);
      tables.set(unquoteIdentifier(renameTo[1]!), table);
    }
    return;
  }

  const renameColumn = action.match(/^RENAME\s+(?:COLUMN\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\s+TO\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (renameColumn && table) {
    const from = unquoteIdentifier(renameColumn[1]!);
    const to = unquoteIdentifier(renameColumn[2]!);
    table.columns = table.columns.map((column) => (column === from ? to : column));
    return;
  }

  const addColumn = action.match(/^ADD\s+(?:COLUMN\s+)?(.*)$/i);
  if (addColumn && table) {
    const column = columnNameOf(addColumn[1]!);
    if (column && !table.columns.includes(column)) table.columns.push(column);
    return;
  }

  const dropColumn = action.match(/^DROP\s+(?:COLUMN\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)/i);
  if (dropColumn && table) {
    const column = unquoteIdentifier(dropColumn[1]!);
    table.columns = table.columns.filter((candidate) => candidate !== column);
  }
}

export function buildSchemaFingerprint(migrationsDir: string): SchemaFingerprint {
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const tables = new Map<string, MutableTable>();
  for (const migration of migrations) {
    for (const statement of splitStatements(readFileSync(resolve(migrationsDir, migration), 'utf8'))) {
      applyStatement(tables, statement);
    }
  }
  const result: Record<string, SchemaFingerprintTable> = {};
  for (const name of [...tables.keys()].sort()) {
    const table = tables.get(name)!;
    result[name] = { columns: [...table.columns], indexes: [...table.indexes].sort() };
  }
  return { migrations, tables: result };
}

export function renderSchemaFingerprintModule(fingerprint: SchemaFingerprint): string {
  return `// GENERATED by scripts/generate-schema-fingerprint.ts — do not edit.
// Replayed from migrations/*.sql at build time; regenerate with \`bun scripts/generate-schema-fingerprint.ts\`.

export const RESERVA_MIGRATIONS = ${JSON.stringify(fingerprint.migrations, null, 2)} as const;

export interface ReservaSchemaTable {
  readonly columns: readonly string[];
  readonly indexes: readonly string[];
}

export const RESERVA_SCHEMA_TABLES: Readonly<Record<string, ReservaSchemaTable>> = ${JSON.stringify(fingerprint.tables, null, 2)};
`;
}

export function generateSchemaFingerprint(repoRoot: string): string {
  const fingerprint = buildSchemaFingerprint(resolve(repoRoot, 'migrations'));
  const outputPath = resolve(repoRoot, 'src/generated/schema-fingerprint.ts');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, renderSchemaFingerprintModule(fingerprint));
  return outputPath;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptRepoRoot = resolve(dirname(scriptPath), '..');

// Runs standalone (`bun scripts/generate-schema-fingerprint.ts`) but stays importable by build.ts,
// which calls generateSchemaFingerprint() directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const outputPath = generateSchemaFingerprint(scriptRepoRoot);
  console.log(`generate-schema-fingerprint: wrote ${outputPath}`);
}
