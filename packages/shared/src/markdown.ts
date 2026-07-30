/**
 * Minimal Markdown → HTML renderer for the subset the server actually emits:
 * headings, bold, italics, inline code, fenced blocks, bullet and numbered
 * lists, block quotes, links and tables.
 *
 * It lives in `shared` rather than in the UI because the safety property it
 * guarantees is worth testing directly: spec and summary text is authored by a
 * model, so **everything is HTML-escaped before any markup is added**. There is
 * no path by which source content becomes live markup.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;

  const closeBlocks = (): void => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      closeBlocks();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${line}\n`);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      closeBlocks();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // The `| --- | --- |` separator carries no content.
    if (/^\|[\s:|-]+\|$/.test(line)) continue;

    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1, -1).split('|').map((cell) => inline(cell.trim()));
      if (!inTable) {
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`);
        inTable = true;
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      }
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    const listItem = bullet?.[1] ?? numbered?.[1];
    if (listItem !== undefined) {
      if (inTable) closeBlocks();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(listItem)}</li>`);
      continue;
    }

    // `>` has already been escaped to `&gt;` by this point.
    if (line.startsWith('&gt; ')) {
      closeBlocks();
      out.push(`<blockquote class="excerpt">${inline(line.slice(5))}</blockquote>`);
      continue;
    }

    closeBlocks();
    out.push(`<p>${inline(line)}</p>`);
  }

  if (inCode) out.push('</code></pre>');
  closeBlocks();
  return out.join('\n');
}

function inline(text: string): string {
  return (
    text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // Only http(s) links become anchors — `javascript:` and `data:` cannot
      // match, so a crafted link in model output stays inert text.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"']+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  );
}
