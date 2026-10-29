// The Mac app's logic, wired together behind a small host interface: follow the service, keep the
// tray (its needs-human count and its lantern), the Dock lantern, and the Dock badge current, and
// send a notification on escalate and merge, and when an epic lands or starts waiting on you. Each host hook fires only when its value changes. The Tiny
// adapter (backend.ts) supplies the host. Runtime-neutral.
import { needsHumanCount, traySpec } from './badge';
import type { TraySpec } from './badge';
import { startFollow } from './follow';
import type { Http } from './http';
import { diffBoard, diffEpics, epicNoticeText, noBaselines, noEpicBaselines, noticeText, retainProjects } from './notify';
import type { Baselines, EpicBaselines, NoticeText } from './notify';
import { badgeText, dockLook, trayRunning } from './lantern';
import type { DockLook } from './lantern';
import type { AppState } from './state';

export interface AppHost {
  http: Http;
  /** The tray: its title and tooltip (`traySpec`), and whether jobs are running (the filled lantern). */
  tray(spec: TraySpec, running: boolean): void;
  /** The Dock icon. */
  dock(look: DockLook): void;
  /** The Dock badge text: `''` clears it. */
  badge(text: string): void;
  notify(n: NoticeText): void;
  log?(line: string): void;
}

export interface App {
  state(): AppState;
  stop(): void;
}

interface Shown {
  title: string;
  tooltip: string;
  running: boolean;
  look: DockLook;
  badge: string;
}

export function startApp(host: AppHost, opts: { retryMs?: number } = {}): App {
  let base: Baselines = noBaselines();
  let epicBase: EpicBaselines = noEpicBaselines();
  let shown: Shown | null = null;
  const show = (s: AppState): void => {
    const n = needsHumanCount(s);
    const spec = traySpec(n);
    const next: Shown = { title: spec.title, tooltip: spec.tooltip, running: trayRunning(s), look: dockLook(s), badge: badgeText(n) };
    const was = shown;
    shown = next;
    if (was === null || was.title !== next.title || was.tooltip !== next.tooltip || was.running !== next.running) host.tray(spec, next.running);
    if (was === null || was.look !== next.look) host.dock(next.look);
    if (was === null || was.badge !== next.badge) host.badge(next.badge);
  };
  const follower = startFollow({
    http: host.http,
    retryMs: opts.retryMs,
    onOpen() {
      base = noBaselines(); // a reconnect re-baselines every project
      epicBase = noEpicBaselines();
      host.log?.('andon: following the service');
    },
    onDown(why) {
      host.log?.(`andon: ${why}; reconnecting`);
    },
    onProjects(projects) {
      const pids = projects.map((p) => p.id);
      base = retainProjects(base, pids);
      epicBase = retainProjects(epicBase, pids);
    },
    onBoard(pid, jobs, epics) {
      const diff = diffBoard(base, pid, jobs);
      base = diff.base;
      const epicDiff = diffEpics(epicBase, pid, epics);
      epicBase = epicDiff.base;
      const name = follower.state().projects.find((p) => p.id === pid)?.name ?? '';
      for (const n of diff.notices) host.notify(noticeText(n, name));
      for (const n of epicDiff.notices) host.notify(epicNoticeText(n, name));
    },
    onState: show,
  });
  return { state: () => follower.state(), stop: () => follower.stop() };
}
