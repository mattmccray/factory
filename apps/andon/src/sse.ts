// A server-sent events frame parser (the WHATWG "event stream" rules), fed text in arbitrary
// chunks. It knows nothing about the service's events: it emits every complete named event once,
// with its full data. Runtime-neutral: no Bun, Node, or txiki imports.

export interface SseEvent {
  event: string; // the `event:` field, or 'message' when the frame names none
  data: string; // every `data:` line of the frame, joined by '\n'
}

export interface SseParser {
  /** Feeds the next chunk of decoded text. A frame may be split anywhere, even inside `\r\n`. */
  push(chunk: string): void;
  /** The stream ended: an unterminated frame is dropped, as the spec requires. */
  end(): void;
}

export function createSseParser(emit: (e: SseEvent) => void): SseParser {
  let line = '';
  let event = '';
  let data: string[] = [];
  let skipLf = false; // the last chunk ended in '\r', so a leading '\n' finishes that line ending
  let started = false;

  function field(text: string): void {
    if (text === '') {
      if (data.length > 0) emit({ event: event === '' ? 'message' : event, data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return; // a comment (the service's keep-alives)
    const colon = text.indexOf(':');
    const name = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
    // `id`, `retry`, and unknown fields are ignored: the Mac app reconnects on its own schedule.
  }

  return {
    push(chunk) {
      let text = chunk;
      if (!started && text.length > 0) {
        started = true;
        if (text.startsWith('﻿')) text = text.slice(1);
      }
      let from = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\n' && skipLf && i === from && line === '') {
          skipLf = false;
          from = i + 1;
          continue;
        }
        skipLf = false;
        if (c === '\r' || c === '\n') {
          field(line + text.slice(from, i));
          line = '';
          from = i + 1;
          if (c === '\r') skipLf = true;
        }
      }
      line += text.slice(from);
    },
    end() {
      line = '';
      event = '';
      data = [];
      skipLf = false;
    },
  };
}
