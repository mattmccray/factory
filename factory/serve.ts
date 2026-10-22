// Factory dashboard server (`bun run factory`). Serves factory/ statically, plus two endpoints
// so the dashboard makes one request per poll instead of one per job and file:
//   GET /board           → { jobs: [...], config }, every jobs/<id>/job.json plus config.json
//                          (a bad config is a 500 carrying the reason)
//   GET /jobs/<id>/docs  → { files: [{ path, text }] }, that job's markdown in reading order
// Paths in `files` are relative to factory/, so a review's ![](ui/x.png) resolves statically.
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseConfig } from './lib/contract.ts';

const ROOT = import.meta.dir;
const JOBS = join(ROOT, 'jobs');
const PORT = Number(process.env.FACTORY_PORT ?? 8765);
const JOB_ID = /^\d{3}-[a-z0-9-]+$/;

// A job.json read mid-write (or not yet written) keeps the job's last good state, so its card
// never drops out of the board for a poll.
const lastGood = new Map<string, Record<string, unknown>>();

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function readJob(id: string) {
  try {
    const job: unknown = JSON.parse(await Bun.file(join(JOBS, id, 'job.json')).text());
    if (job && typeof job === 'object' && !Array.isArray(job)) lastGood.set(id, { ...job });
  } catch {
    // missing or mid-write: fall back to the last good read
  }
  return lastGood.get(id);
}

// Read per request so an edit to config.json shows up on the next poll.
async function readConfig() {
  return parseConfig(JSON.parse(await Bun.file(join(ROOT, 'config.json')).text()));
}

async function board() {
  const config = await readConfig();
  const ids = (await entries(JOBS)).filter((d) => d.isDirectory() && JOB_ID.test(d.name)).map((d) => d.name);
  const jobs = await Promise.all(ids.map(readJob));
  return { jobs: jobs.filter((j) => j !== undefined), config };
}

const num = (name: string) => Number(name.match(/\d+/)?.[0] ?? 0);

async function docs(id: string) {
  const { reviewers } = await readConfig();
  const dir = join(JOBS, id);
  const top = (await entries(dir)).filter((d) => d.isFile()).map((d) => d.name);
  const reworks = top.filter((f) => /^rework-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const paths = ['feature.md', 'spec.md', 'build.md', ...reworks, 'decision.md']
    .filter((f) => top.includes(f))
    .map((f) => `jobs/${id}/${f}`);

  const brief = (await readJob(id))?.brief;
  if (typeof brief === 'string' && /^factory\/briefs\/[\w.-]+\.md$/.test(brief)) {
    const rel = brief.replace(/^factory\//, '');
    if (await Bun.file(join(ROOT, rel)).exists()) paths.unshift(rel);
  }

  const rounds = (await entries(dir)).filter((d) => d.isDirectory() && /^round-\d+$/.test(d.name)).map((d) => d.name);
  for (const round of rounds.sort((a, b) => num(a) - num(b))) {
    const files = (await entries(join(dir, round))).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name);
    const rank = (f: string) => {
      const i = reviewers.indexOf(f.replace(/^review-|\.md$/g, ''));
      return i === -1 ? reviewers.length : i;
    };
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    paths.push(...files.map((f) => `jobs/${id}/${round}/${f}`));
  }

  const files = await Promise.all(paths.map(async (path) => ({ path, text: await Bun.file(join(ROOT, path)).text() })));
  return { files };
}

const json = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } });

async function serveStatic(pathname: string) {
  if (pathname === '/') return Response.redirect('/dashboard.html', 302);
  const segments = decodeURIComponent(pathname).split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return new Response('Not found', { status: 404 });  // .worktrees, .lock
  const path = resolve(ROOT, ...segments);
  if (!path.startsWith(ROOT + sep)) return new Response('Not found', { status: 404 });
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return new Response('Not found', { status: 404 });
  return new Response(Bun.file(path), { headers: { 'cache-control': 'no-store' } });
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/board') {
      try {
        return json(await board());
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return new Response(`config.json: ${reason}`, { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }
    const m = pathname.match(/^\/jobs\/([^/]+)\/docs$/);
    if (m?.[1] && JOB_ID.test(m[1])) {
      try {
        return json(await docs(m[1]));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return new Response(`config.json: ${reason}`, { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }
    return serveStatic(pathname);
  },
});

console.log(`Factory dashboard: http://localhost:${PORT}/dashboard.html`);
