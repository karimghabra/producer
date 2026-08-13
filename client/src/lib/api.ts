import type { Project, ProjectSummary } from '@shared/types';

interface Envelope<T> { ok: boolean; data?: T; error?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let body: Envelope<T>;
  try {
    body = await res.json() as Envelope<T>;
  } catch {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body.data as T;
}

export const listProjects = () => call<ProjectSummary[]>('/projects');

export const getProject = (id: string) => call<Project>(`/projects/${id}`);

export const createProject = (name: string) =>
  call<Project>('/projects', { method: 'POST', body: JSON.stringify({ name }) });

export const saveProject = (p: Project) =>
  call<{ id: string; updatedAt: number }>(`/projects/${p.id}`, {
    method: 'PUT',
    body: JSON.stringify(p),
  });

export const duplicateProject = (id: string) =>
  call<Project>(`/projects/${id}/duplicate`, { method: 'POST' });

export const deleteProject = (id: string) =>
  call<{ id: string }>(`/projects/${id}`, { method: 'DELETE' });

export const health = () =>
  call<{ status: string; backend: string }>('/health');
