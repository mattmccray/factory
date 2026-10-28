import { expect, test } from 'bun:test';
import { createSseParser } from './sse';
import type { SseEvent } from './sse';

function parseChunks(chunks: string[]): SseEvent[] {
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

/** Every split of `text` into two chunks, and into single characters. */
function splits(text: string): string[][] {
  const out: string[][] = [[text], [...text]];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

const STREAM =
  '﻿: keep-alive\r\n' +
  'event: projects\r\ndata: {"projects":[]}\r\n\r\n' +
  ':comment\n' +
  'event: board\ndata: {"project":"a",\ndata: "jobs":[]}\n\n' +
  'event:error\rdata:{"project":"a","reason":"config.json: bad"}\r\r' +
  'data: plain\n\n' +
  'retry: 10\nid: 7\nevent: board\ndata:  two spaces\n\n' +
  'event: board\ndata: never finished';

const WANT: SseEvent[] = [
  { event: 'projects', data: '{"projects":[]}' },
  { event: 'board', data: '{"project":"a",\n"jobs":[]}' },
  { event: 'error', data: '{"project":"a","reason":"config.json: bad"}' },
  { event: 'message', data: 'plain' },
  { event: 'board', data: ' two spaces' },
];

test('AC3: each named event is emitted once with its full data, however the body is chunked', () => {
  for (const chunks of splits(STREAM)) expect({ chunks, events: parseChunks(chunks) }).toEqual({ chunks, events: WANT });
});

test('AC3: a frame with no data, or only an event name, emits nothing; a blank run of lines is harmless', () => {
  expect(parseChunks(['event: board\n\n\n\n', ': x\n\n'])).toEqual([]);
});

test('AC3: "\\r\\n" split across chunks is one line ending, not two', () => {
  expect(parseChunks(['event: a\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([{ event: 'a', data: '1' }]);
});
