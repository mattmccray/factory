// The factory CLI — the only writer of job state (factory/CONTRACT.md).
//   bun factory/cli.ts event <id> <type> [k=v …]
//   bun factory/cli.ts rebuild <id> | --all
//   bun factory/cli.ts show <id>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, parseEventInput } from './lib/contract';
import { parseFields } from './lib/fields';
import { project } from './lib/project';
import { formatShow } from './lib/show';
import { appendEvent, readLog, rebuild } from './lib/store';

const root = import.meta.dir;

async function show(id: string): Promise<void> {
  const log = await readLog(root, id);
  if (log.length === 0) throw new Error(`${id}: no events.jsonl (legacy or unknown job)`);
  for (const line of formatShow(project(log), new Date())) console.log(line);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
  switch (cmd) {
    case 'event': {
      const [id, type, ...kv] = rest;
      if (!id || !type) throw new Error('usage: event <id> <type> [field=value …]');
      const input = parseEventInput(type, parseFields(kv), { id, config });
      console.log((await appendEvent(root, id, input)).stage);
      return;
    }
    case 'rebuild': {
      const [target] = rest;
      if (!target) throw new Error('usage: rebuild <id> | --all');
      const ids = await rebuild(root, target === '--all' ? undefined : target);
      console.log(`rebuilt ${ids.length}: ${ids.join(' ')}`);
      return;
    }
    case 'show': {
      if (!rest[0]) throw new Error('usage: show <id>');
      await show(rest[0]);
      return;
    }
    default:
      throw new Error('usage: event <id> <type> [k=v …] | rebuild <id>|--all | show <id>');
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.split('\n')[0] : String(e));
  process.exit(1);
});
