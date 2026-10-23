import { expect, test } from 'bun:test';
import { curlArgv, responseFromCurl } from './curl';

const enc = new TextEncoder();
const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });

test('curl is asked for the response head, unbuffered, with no proxy', () => {
  const argv = curlArgv('http://127.0.0.1:8766/events');
  expect(argv[0]).toBe('curl');
  expect(argv).toContain('--include');
  expect(argv).toContain('--no-buffer');
  expect(argv.at(-1)).toBe('http://127.0.0.1:8766/events');
  expect(argv.some((a) => /origin|host/i.test(a))).toBe(false); // curl's own Host, no Origin
});

test('the status and body are read from --include output, however it is chunked', async () => {
  const res = await responseFromCurl(streamOf(['HTTP/1.1 200 OK\r\ncontent-type: application/json\r', '\n\r\n{"projects":', '[]}']));
  expect(res.ok).toBe(true);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"projects":[]}');
});

test('an error status is not ok, and an interim 100 head is skipped', async () => {
  const res = await responseFromCurl(streamOf(['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 500 Internal\r\n\r\nconfig.json: bad']));
  expect(res.ok).toBe(false);
  expect(res.status).toBe(500);
  expect(await res.text()).toBe('config.json: bad');
});

test('no output at all (the agent is unreachable) rejects, and cancelling the body stops curl', async () => {
  let cancels = 0;
  expect(responseFromCurl(streamOf([]), () => cancels++)).rejects.toThrow('unreachable');
  await Bun.sleep(1);
  expect(cancels).toBe(1);
  const res = await responseFromCurl(streamOf(['HTTP/1.1 200 OK\r\n\r\nevent: x\n']), () => cancels++);
  await res.body?.cancel();
  expect(cancels).toBe(2);
});

test('against a real server, curl sends the agent its own Host and no Origin', async () => {
  const seen: Array<[string | null, string | null]> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      seen.push([req.headers.get('host'), req.headers.get('origin')]);
      return new Response('ok');
    },
  });
  try {
    const p = Bun.spawn(curlArgv(`http://127.0.0.1:${server.port}/projects`), { stdout: 'pipe' });
    const res = await responseFromCurl(p.stdout);
    expect(await res.text()).toBe('ok');
    expect(seen).toEqual([[`127.0.0.1:${server.port}`, null]]);
  } finally {
    server.stop(true);
  }
});
