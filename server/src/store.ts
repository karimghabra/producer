/**
 * Persistence.
 *
 * Node 24 ships SQLite in core, so there is no native module to compile. If
 * `node:sqlite` is unavailable for any reason we fall back to a directory of
 * JSON files, which is perfectly adequate at this scale and keeps the app
 * runnable anywhere.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', 'data');
const JSON_DIR = join(DATA_DIR, 'projects');

export interface StoredProject {
  id: string;
  name: string;
  bpm: number;
  createdAt: number;
  updatedAt: number;
  /** The full Project document. */
  doc: unknown;
}

export interface Store {
  backend: 'sqlite' | 'json';
  list(): Array<Omit<StoredProject, 'doc'>>;
  get(id: string): StoredProject | null;
  put(p: StoredProject): void;
  remove(id: string): boolean;
}

mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function trySqlite(): Promise<Store | null> {
  let DatabaseSync: new (path: string) => any;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }

  try {
    const db = new DatabaseSync(join(DATA_DIR, 'pulse.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        bpm        REAL NOT NULL DEFAULT 128,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        doc        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
    `);

    const listStmt = db.prepare(
      'SELECT id, name, bpm, created_at, updated_at FROM projects ORDER BY updated_at DESC',
    );
    const getStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    const putStmt = db.prepare(`
      INSERT INTO projects (id, name, bpm, created_at, updated_at, doc)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        bpm = excluded.bpm,
        updated_at = excluded.updated_at,
        doc = excluded.doc
    `);
    const delStmt = db.prepare('DELETE FROM projects WHERE id = ?');

    return {
      backend: 'sqlite',
      list: () =>
        listStmt.all().map((r: any) => ({
          id: r.id, name: r.name, bpm: r.bpm,
          createdAt: r.created_at, updatedAt: r.updated_at,
        })),
      get: (id) => {
        const r: any = getStmt.get(id);
        if (!r) return null;
        return {
          id: r.id, name: r.name, bpm: r.bpm,
          createdAt: r.created_at, updatedAt: r.updated_at,
          doc: JSON.parse(r.doc),
        };
      },
      put: (p) => {
        putStmt.run(p.id, p.name, p.bpm, p.createdAt, p.updatedAt, JSON.stringify(p.doc));
      },
      remove: (id) => {
        const info: any = delStmt.run(id);
        return Number(info?.changes ?? 0) > 0;
      },
    };
  } catch (err) {
    console.warn('[store] sqlite unavailable, falling back to JSON:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON fallback
// ---------------------------------------------------------------------------

function jsonStore(): Store {
  mkdirSync(JSON_DIR, { recursive: true });
  const pathFor = (id: string) => join(JSON_DIR, `${id.replace(/[^\w.-]/g, '_')}.json`);

  return {
    backend: 'json',
    list: () =>
      readdirSync(JSON_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const p = JSON.parse(readFileSync(join(JSON_DIR, f), 'utf8')) as StoredProject;
            return { id: p.id, name: p.name, bpm: p.bpm, createdAt: p.createdAt, updatedAt: p.updatedAt };
          } catch {
            return null;
          }
        })
        .filter((x): x is Omit<StoredProject, 'doc'> => x !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => {
      const f = pathFor(id);
      if (!existsSync(f)) return null;
      try { return JSON.parse(readFileSync(f, 'utf8')) as StoredProject; } catch { return null; }
    },
    put: (p) => { writeFileSync(pathFor(p.id), JSON.stringify(p, null, 2), 'utf8'); },
    remove: (id) => {
      const f = pathFor(id);
      if (!existsSync(f)) return false;
      unlinkSync(f);
      return true;
    },
  };
}

export async function openStore(): Promise<Store> {
  return (await trySqlite()) ?? jsonStore();
}
