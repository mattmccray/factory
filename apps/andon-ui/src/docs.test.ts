import { describe, expect, test } from 'bun:test';
import { fetchEpicDocs, getJson } from './api';
import { TIMING, groupsOf, pickFile, verdictOf } from './docs';
import { markdown } from './markdown';

const files = [
  { path: 'briefs/x.md', text: 'brief' },
  { path: 'jobs/001-a/feature.md', text: 'feature' },
  { path: 'jobs/001-a/spec.md', text: '# Spec' },
  { path: 'jobs/001-a/round-1/review-code.md', text: 'VERDICT: CHANGES\n…' },
  { path: 'jobs/001-a/round-1/review-security.md', text: 'PASS' },
  { path: 'jobs/001-a/decision.md', text: 'APPROVE\n' },
];

describe('drawer files', () => {
  test('grouped as Job then one group per round, labeled, with verdicts', () => {
    expect(groupsOf(files).map((g) => [g.name, g.files.map((f) => `${f.label}:${f.verdict ?? ''}`)])).toEqual([
      ['Job', ['brief:', 'feature.md:', 'spec.md:', 'decision.md:APPROVE']],
      ['Round 1', ['code.md:CHANGES', 'security.md:PASS']],
    ]);
    expect(verdictOf('PASSING grade')).toBeNull();
  });

  test('the shown file: current while present, else the latest non-feature file; timing only with timing', () => {
    expect(pickFile(null, files, true)).toBe('jobs/001-a/decision.md');
    expect(pickFile('jobs/001-a/spec.md', files, true)).toBe('jobs/001-a/spec.md');
    expect(pickFile('jobs/001-a/gone.md', files, true)).toBe('jobs/001-a/decision.md');
    expect(pickFile(TIMING, files, true)).toBe(TIMING);
    expect(pickFile(TIMING, files, false)).toBe('jobs/001-a/decision.md');
    expect(pickFile(null, [{ path: 'jobs/001-a/feature.md', text: '' }], false)).toBe('jobs/001-a/feature.md');
    expect(pickFile(null, [], false)).toBeNull();
  });
});

describe('markdown', () => {
  test('escapes its input before adding markup', () => {
    const html = markdown('# Title <script>\n\nSome **bold** and `code` <img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://e.com)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('<h1>Title &lt;script&gt;</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://e.com" target="_blank" rel="noopener">ok</a>');
  });

  test('stamps a leading verdict and renders lists, tasks, tables, and code', () => {
    const html = markdown('VERDICT: PASS\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```');
    expect(html).toStartWith('<div class="stamp PASS">PASS</div>');
    expect(html).toContain('<li class="task">☑ done</li>');
    expect(html).toContain('<td>1</td><td>2</td>');
    expect(html).toContain('<pre><code>x &lt; y</code></pre>');
  });

  test('an image renders as its alt text (the service serves no job images)', () => {
    expect(markdown('![desktop](ui/a.png)')).toContain('[image: desktop]');
  });
});

describe('getJson', () => {
  test('a non-2xx response throws with the first line of its body', async () => {
    const fail = async () => ({ ok: false, status: 500, text: async () => 'config.json: bad thing\nstack' });
    await expect(getJson(fail, '/x')).rejects.toThrow('config.json: bad thing');
    const empty = async () => ({ ok: false, status: 404, text: async () => '' });
    await expect(getJson(empty, '/x')).rejects.toThrow('HTTP 404');
  });
});

describe('an epic\'s documents (056 AC6)', () => {
  test("are fetched from its own project's epic docs endpoint, plan first, and a malformed entry is skipped", async () => {
    const asked: string[] = [];
    const files = [{ path: 'epics/auth.md', text: '# Auth' }, { path: 'briefs/a.md', text: 'a' }, { path: 7, text: 'x' }, 'junk'];
    const fetcher = async (path: string) => {
      asked.push(path);
      return { ok: true, status: 200, text: async () => JSON.stringify({ files }) };
    };
    expect(await fetchEpicDocs(fetcher, 'p 1', 'auth')).toEqual([
      { path: 'epics/auth.md', text: '# Auth' },
      { path: 'briefs/a.md', text: 'a' },
    ]);
    expect(asked).toEqual(['/projects/p%201/epics/auth/docs']);
    const missing = async () => ({ ok: false, status: 404, text: async () => 'not found' });
    await expect(fetchEpicDocs(missing, 'p1', 'gone')).rejects.toThrow('not found');
  });
});
