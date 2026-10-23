// Test support: a throwaway git repo for the CLI's target resolution (`git.ts`). Not part of the
// installed CLI (nothing in `installed.ts` imports it).

/** Runs git in `repo` with a fixed identity; throws on a non-zero exit. */
export function gitIn(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=factory-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/** Makes `repo` a git repo on `branch` with one empty commit. */
export function initRepo(repo: string, branch = 'main'): void {
  gitIn(repo, 'init', '--quiet', `--initial-branch=${branch}`);
  gitIn(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
}
