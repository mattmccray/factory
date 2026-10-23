// The shell's logic, wired together behind a small host interface: follow the agent, keep the
// tray's needs-human count current, and send a notification on escalate and merge. The Tiny
// adapter (backend.ts) supplies the host. Runtime-neutral.
import { needsHumanCount, traySpec } from './badge';
import type { TraySpec } from './badge';
import { startFollow } from './follow';
import type { Http } from './http';
import { diffBoard, noBaselines, noticeText, retainProjects } from './notify';
import type { Baselines, NoticeText } from './notify';
import type { ShellState } from './state';

export interface ShellHost {
  http: Http;
  tray(spec: TraySpec): void;
  notify(n: NoticeText): void;
  log?(line: string): void;
}

export interface Shell {
  state(): ShellState;
  stop(): void;
}

const sameTray = (a: TraySpec | null, b: TraySpec): boolean => a !== null && a.title === b.title && a.tooltip === b.tooltip;

export function startShell(host: ShellHost, opts: { retryMs?: number } = {}): Shell {
  let base: Baselines = noBaselines();
  let shown: TraySpec | null = null;
  const tray = (s: ShellState): void => {
    const next = traySpec(needsHumanCount(s));
    if (sameTray(shown, next)) return;
    shown = next;
    host.tray(next);
  };
  const follower = startFollow({
    http: host.http,
    retryMs: opts.retryMs,
    onOpen() {
      base = noBaselines(); // a reconnect re-baselines every project
      host.log?.('andon-shell: following the agent');
    },
    onDown(why) {
      host.log?.(`andon-shell: ${why}; reconnecting`);
    },
    onProjects(projects) {
      base = retainProjects(
        base,
        projects.map((p) => p.id),
      );
    },
    onBoard(pid, jobs) {
      const diff = diffBoard(base, pid, jobs);
      base = diff.base;
      const name = follower.state().projects.find((p) => p.id === pid)?.name ?? '';
      for (const n of diff.notices) host.notify(noticeText(n, name));
    },
    onState: tray,
  });
  return { state: () => follower.state(), stop: () => follower.stop() };
}
