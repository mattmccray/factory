// Test support for the epic commands: a throwaway git repo with a factory/, a plan, and member
// briefs, and helpers that drive the CLI. Not part of the installed CLI (nothing in `installed.ts`
// imports it).
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, initRepo } from './gitrepo';
import { run } from './index';

export interface Result {
  code: number;
  out: string[];
  err: string[];
}

export const CONFIG = { schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

export const plan = (status: string, members: string[]): string =>
  ['# An epic', '', `- Status: ${status}`, '- Date: 2026-10-29', '', '## Intent', 'Why.', '', '## Members', ...members, ''].join('\n');
export const brief = (status: string): string => `# A brief\n\n- Status: ${status}\n\n## Intent\nx\n`;

export class Fixture {
  repo = '';
  root = '';
  now: (() => Date) | undefined;

  async setUp(config: Record<string, unknown> = CONFIG): Promise<void> {
    this.repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-epic-')));
    initRepo(this.repo, 'main');
    this.root = join(this.repo, 'factory');
    await mkdir(join(this.root, 'epics'), { recursive: true });
    await mkdir(join(this.root, 'briefs'), { recursive: true });
    await this.config(config);
  }

  async tearDown(): Promise<void> {
    await rm(this.repo, { recursive: true, force: true });
  }

  config(config: Record<string, unknown>): Promise<void> {
    return writeFile(join(this.root, 'config.json'), JSON.stringify(config));
  }

  writePlan(slug: string, text: string): Promise<void> {
    return writeFile(join(this.root, 'epics', `${slug}.md`), text);
  }

  async briefs(status: string, ...slugs: string[]): Promise<void> {
    for (const s of slugs) await writeFile(join(this.root, 'briefs', `${s}.md`), brief(status));
  }

  async cli(...argv: string[]): Promise<Result> {
    const out: string[] = [];
    const err: string[] = [];
    const io = { root: this.root, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), ...(this.now === undefined ? {} : { now: this.now }) };
    const code = await run(argv, io);
    return { code, out, err };
  }

  async ok(...argv: string[]): Promise<string[]> {
    const r = await this.cli(...argv);
    if (r.code !== 0) throw new Error(`${argv.join(' ')}: ${r.err.join(' ')}`);
    return r.out;
  }

  hasBranch(name: string): boolean {
    return gitIn(this.repo, 'branch', '--list', name) !== '';
  }

  git(...args: string[]): string {
    return gitIn(this.repo, ...args);
  }

  async json(...rel: string[]): Promise<Record<string, unknown>> {
    const raw: unknown = JSON.parse(await readFile(join(this.root, ...rel), 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object');
    return Object.fromEntries(Object.entries(raw));
  }

  async lines(...rel: string[]): Promise<Record<string, unknown>[]> {
    const text = await readFile(join(this.root, ...rel), 'utf8');
    return text.trim().split('\n').map((l) => {
      const raw: unknown = JSON.parse(l);
      if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
      return Object.fromEntries(Object.entries(raw));
    });
  }

  /** Every file under factory/jobs and factory/.worktrees' names, with bytes, for no-op checks. */
  async state(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(dir, e.name);
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          out[`${r}/`] = '';
          if (rel !== '.worktrees') await walk(p, r);
        } else out[r] = await readFile(p, 'utf8');
      }
    };
    await walk(join(this.root, 'jobs'), 'jobs');
    await walk(join(this.root, '.worktrees'), '.worktrees');
    out.branches = this.git('branch', '--list', '--format=%(refname:short)');
    return out;
  }

  /** Starts epic `slug` over `members` (all ready briefs); returns nothing. */
  async start(slug: string, members: string[], memberLines?: string[]): Promise<void> {
    await this.briefs('ready', ...members);
    await this.writePlan(slug, plan('ready', memberLines ?? members.map((m) => `- \`${m}\``)));
    await this.ok('epic', 'start', slug);
  }

  /** Claims member `m` into epic `epic`; returns the job id. */
  async claimMember(epic: string, m: string, ...extra: string[]): Promise<string> {
    const [id] = await this.ok('claim', m, `epic=${epic}`, `brief=factory/briefs/${m}.md`, ...extra);
    if (id === undefined) throw new Error('no id');
    return id;
  }

  /** Drives job `id` from claimed to approve (one review round, reviewer `code` PASSes). */
  async toApprove(id: string): Promise<void> {
    await this.ok('event', id, 'stage.entered', 'stage=spec');
    await this.ok('event', id, 'stage.entered', 'stage=build');
    await this.ok('event', id, 'round.started', 'round=1');
    await mkdir(join(this.root, 'jobs', id, 'round-1'), { recursive: true });
    await writeFile(join(this.root, 'jobs', id, 'round-1', 'review-code.md'), 'VERDICT: PASS\n');
    await this.ok('event', id, 'agent.finished', 'role=reviewer', 'key=code', 'round=1');
    await this.ok('event', id, 'stage.entered', 'stage=approve');
  }

  /** Drives job `id` to merged. */
  async merge(id: string): Promise<void> {
    await this.toApprove(id);
    await this.ok('event', id, 'job.merged', 'sha=0123abc');
  }
}
