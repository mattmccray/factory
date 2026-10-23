// A GET through the system `curl`, for the txiki backend. txiki.js 26.6.0's `fetch` does stream
// response bodies, but it sends `Host: 127.0.0.1` without the port and adds an
// `Origin: http://127.0.0.1` of its own, so the agent's DNS-rebinding guard answers every request
// with a 403 (a header given in `init` is appended, not replaced). curl sends `Host:
// 127.0.0.1:<port>` and no `Origin`, which is exactly what the UI's requests look like to the
// agent. The adapter spawns `curlArgv(url)` and hands its stdout here. Runtime-neutral: this file
// only builds the command line and parses curl's `--include` output.
import type { HttpResponse } from './http';

/** curl, quiet but for errors, with the response head on stdout and no output buffering. */
export const curlArgv = (url: string): string[] => ['curl', '--silent', '--show-error', '--include', '--no-buffer', '--noproxy', '*', '--connect-timeout', '2', url];

const HEAD_END = [13, 10, 13, 10]; // \r\n\r\n

function indexOfHeadEnd(buf: Uint8Array): number {
  outer: for (let i = 0; i + HEAD_END.length <= buf.length; i++) {
    for (let k = 0; k < HEAD_END.length; k++) if (buf[i + k] !== HEAD_END[k]) continue outer;
    return i;
  }
  return -1;
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * Reads curl's `--include` stdout: the status line and headers, then the body as a stream. Rejects
 * when curl printed no response (the agent is unreachable). Cancelling the body calls `cancel`, so
 * the adapter can stop the curl process.
 */
export async function responseFromCurl(stdout: ReadableStream<Uint8Array>, cancel: () => void = () => undefined): Promise<HttpResponse> {
  const reader = stdout.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let status = 0;
  for (;;) {
    const end = indexOfHeadEnd(buf);
    if (end >= 0) {
      const head = new TextDecoder().decode(buf.subarray(0, end));
      const m = /^HTTP\/[\d.]+ (\d{3})/.exec(head);
      if (m === null || m[1] === undefined) {
        cancel();
        throw new Error('the agent sent no HTTP response');
      }
      status = Number(m[1]);
      buf = buf.subarray(end + HEAD_END.length);
      if (status >= 100 && status < 200) continue; // an interim response; the real head follows
      break;
    }
    const { value, done } = await reader.read();
    if (done) {
      cancel();
      throw new Error('the agent is unreachable');
    }
    buf = concat(buf, value);
  }

  let rest: Uint8Array | null = buf.length > 0 ? buf : null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (rest !== null) {
        controller.enqueue(rest);
        rest = null;
        return;
      }
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      cancel();
      await reader.cancel().catch(() => undefined);
    },
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    async text() {
      const r = body.getReader();
      const decoder = new TextDecoder();
      let out = '';
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      return out + decoder.decode();
    },
  };
}
