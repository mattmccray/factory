// The drawer's tiny markdown renderer, ported from the vendored dashboard. The input is
// HTML-escaped before any markup is added, so its output is safe to insert as HTML. The agent
// serves no job images, so an image renders as its alt text.

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function inline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\(([\w./-]+\.(?:png|jpe?g|webp|gif))\)/g, (_m, alt: string, src: string) => `<span class="img-alt" title="${src}">[image${alt ? `: ${alt}` : ''}]</span>`)
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|#)[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const LIST = /^\s*([-*]|\d+\.)\s+/;
const ROW = /^\s*\|.*\|\s*$/;

export function markdown(src: string): string {
  const lines = esc(src).split('\n');
  const out: string[] = [];
  const first = lines[0]?.match(/^(?:VERDICT:\s*)?(PASS|CHANGES|APPROVE|ESCALATE)\s*$/);
  if (first?.[1] !== undefined) {
    out.push(`<div class="stamp ${first[1]}">${first[1]}</div>`);
    lines.shift();
  }
  const at = (n: number): string => lines[n] ?? '';
  for (let i = 0; i < lines.length; ) {
    const l = at(i);
    if (/^```/.test(l)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(at(i))) buf.push(at(i++));
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h !== null) {
      const n = (h[1] ?? '#').length;
      out.push(`<h${n}>${inline(h[2] ?? '')}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (ROW.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(at(i + 1))) {
      const cells = (row: string): string[] =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && ROW.test(at(i))) rows.push(cells(at(i++)));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length) {
        const li = at(i);
        if (LIST.test(li)) {
          items.push(li.replace(LIST, ''));
          i++;
        } else if (/^\s{2,}\S/.test(li) && items.length > 0) {
          items[items.length - 1] += ` ${li.trim()}`;
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((it) => {
        const t = it.match(/^\[([ xX])\]\s+(.*)/);
        return t !== null ? `<li class="task">${t[1] === ' ' ? '☐' : '☑'} ${inline(t[2] ?? '')}</li>` : `<li>${inline(it)}</li>`;
      });
      out.push(`<${tag}>${lis.join('')}</${tag}>`);
      continue;
    }
    if (/^&gt;\s?/.test(l)) {
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(at(i))) buf.push(at(i++).replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (l.trim() === '') {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && at(i).trim() !== '' && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|&gt;|\s*\|)/.test(at(i))) buf.push(at(i++));
    if (buf.length === 0) buf.push(at(i++));
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
