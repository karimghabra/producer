/**
 * Pulse API.
 *
 * Deliberately small: projects are self-contained JSON documents, so the
 * server's whole job is to hold them, list them, and hand them back. All the
 * musical work happens in the browser where the audio clock lives.
 */

import express from 'express';
import cors from 'cors';
import { openStore, type StoredProject } from './store.ts';
import { createProject } from '../../shared/defaults.ts';
import type { Project } from '../../shared/types.ts';

// Deliberately not `PORT`: dev harnesses set that for the front end, and the
// API silently stealing the client's port is a confusing failure to debug.
const PORT = Number(process.env.API_PORT ?? 5178);
const store = await openStore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

const ok = <T,>(res: express.Response, data: T) => res.json({ ok: true, data });
const fail = (res: express.Response, code: number, message: string) =>
  res.status(code).json({ ok: false, error: message });

function isProject(v: unknown): v is Project {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<Project>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.bpm === 'number' &&
    Array.isArray(p.tracks) &&
    !!p.keymap &&
    Array.isArray(p.keymap.layers)
  );
}

app.get('/api/health', (_req, res) => {
  ok(res, { status: 'up', backend: store.backend, time: Date.now() });
});

app.get('/api/projects', (_req, res) => {
  ok(res, store.list());
});

app.post('/api/projects', (req, res) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim()
    : 'Untitled';
  const project = createProject(name);
  store.put(toStored(project));
  ok(res, project);
});

app.get('/api/projects/:id', (req, res) => {
  const row = store.get(req.params.id);
  if (!row) return fail(res, 404, 'Project not found');
  ok(res, row.doc);
});

app.put('/api/projects/:id', (req, res) => {
  const body = req.body;
  if (!isProject(body)) return fail(res, 400, 'Body is not a valid project document');
  if (body.id !== req.params.id) return fail(res, 400, 'Project id does not match the URL');

  const existing = store.get(req.params.id);
  const record: StoredProject = {
    id: body.id,
    name: body.name,
    bpm: body.bpm,
    createdAt: existing?.createdAt ?? body.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    doc: { ...body, updatedAt: Date.now() },
  };
  store.put(record);
  ok(res, { id: record.id, updatedAt: record.updatedAt });
});

app.post('/api/projects/:id/duplicate', (req, res) => {
  const row = store.get(req.params.id);
  if (!row) return fail(res, 404, 'Project not found');
  const src = row.doc as Project;
  const copy: Project = {
    ...structuredClone(src),
    id: `prj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
    name: `${src.name} copy`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.put(toStored(copy));
  ok(res, copy);
});

app.delete('/api/projects/:id', (req, res) => {
  if (!store.remove(req.params.id)) return fail(res, 404, 'Project not found');
  ok(res, { id: req.params.id, deleted: true });
});

function toStored(p: Project): StoredProject {
  return {
    id: p.id, name: p.name, bpm: p.bpm,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
    doc: p,
  };
}

app.use((_req, res) => fail(res, 404, 'No such route'));

/**
 * Bind with retries.
 *
 * `node --watch` restarts this process the instant a file changes, which can
 * easily happen before the previous instance has released its socket. An
 * unhandled EADDRINUSE takes the process down and --watch then idles until the
 * *next* file change — so a momentary clash leaves the API dead indefinitely
 * while the front end carries on looking healthy. Retrying costs nothing and
 * removes that failure mode entirely.
 */
const MAX_BIND_ATTEMPTS = 8;

function listen(port: number, attempt = 1): void {
  const server = app.listen(port);

  server.once('listening', () => {
    console.log(`\n  ▸ Pulse API on http://localhost:${port}  (store: ${store.backend})\n`);
  });

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;

    if (attempt >= MAX_BIND_ATTEMPTS) {
      console.error(
        `\n  ✖ Port ${port} is still in use after ${attempt} attempts.\n` +
        `    Another process is holding it. Free it, or start with a different port:\n` +
        `      API_PORT=5179 npm run dev:server\n` +
        `    (the client proxy in client/vite.config.ts points at 5178)\n`,
      );
      process.exit(1);
    }

    const delay = 200 * attempt;
    console.warn(`  … port ${port} busy, retrying in ${delay}ms (${attempt}/${MAX_BIND_ATTEMPTS})`);
    // Deliberately not unref'd: a failed listen leaves nothing else holding the
    // event loop open, so an unref'd timer would let the process exit before
    // the retry ever ran.
    setTimeout(() => listen(port, attempt + 1), delay);
  });
}

listen(PORT);
