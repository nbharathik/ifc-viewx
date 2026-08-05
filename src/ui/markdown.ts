// Markdown to DOM, for the assistant transcript. Models answer in Markdown, so
// a chat that shows the raw source is showing the wrong thing.
//
// Every node here is created, never parsed out of a string, so model output can
// carry no markup into the page. Scope is what a model actually emits: headings,
// lists, tables, fenced code, quotes, and the four inline spans.
import { h, icon, toast } from "./kit.js";

const FENCE = /^\s*```(\w*)/;
const HEAD = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** A link the model wrote is data: only schemes that just navigate survive. */
function link(label: string, href: string): Node {
  if (!/^(https?:|mailto:)/i.test(href)) return document.createTextNode(`${label} (${href})`);
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", text: label });
}

function inline(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(document.createTextNode(text.slice(at, m.index)));
    if (m[1] !== undefined) out.push(h("code", { text: m[1] }));
    else if (m[2] ?? m[3]) out.push(h("strong", { text: m[2] ?? m[3] }));
    else if (m[4]) out.push(h("em", { text: m[4] }));
    else out.push(link(m[5], m[6]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

const cells = (line: string): string[] =>
  line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/** A fenced block, with its language and a copy button: code is meant to leave. */
export function codeBlock(code: string, lang = ""): HTMLElement {
  const copy = h("button", { class: "icon-btn sm ghost", type: "button", title: "Copy" }, [icon("copy")]);
  copy.addEventListener("click", () => {
    if (!navigator.clipboard) return toast("The browser blocked the clipboard", "error");
    void navigator.clipboard
      .writeText(code)
      .then(() => toast("Copied", "success"))
      .catch(() => toast("The browser blocked the clipboard", "error"));
  });
  // With no language there is nothing to label, so the button floats in the
  // corner rather than reserving a strip of its own.
  return h("div", { class: `md-code${lang ? "" : " bare"}` }, [
    h("div", { class: "md-code-bar" }, [h("span", { text: lang }), copy]),
    h("pre", {}, [h("code", { text: code })]),
  ]);
}

export function markdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const para: string[] = [];
  const flush = (): void => {
    if (!para.length) return;
    frag.appendChild(h("p", {}, inline(para.join(" "))));
    para.length = 0;
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) body.push(lines[i]);
      frag.appendChild(codeBlock(body.join("\n"), fence[1]));
      i += 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    const head = HEAD.exec(line);
    if (head) {
      flush();
      frag.appendChild(h(head[1].length > 2 ? "h5" : "h4", {}, inline(head[2])));
      i += 1;
      continue;
    }
    if (RULE.test(line.trim())) {
      flush();
      frag.appendChild(h("hr"));
      i += 1;
      continue;
    }
    // A table needs its divider row: one pipe in a sentence is not a table.
    if (line.includes("|") && DIVIDER.test(lines[i + 1] ?? "")) {
      flush();
      const table = h("table", { class: "md-table" });
      table.appendChild(h("thead", {}, [h("tr", {}, cells(line).map((c) => h("th", {}, inline(c))))]));
      const body = h("tbody");
      for (i += 2; i < lines.length && lines[i].includes("|"); i += 1) {
        body.appendChild(h("tr", {}, cells(lines[i]).map((c) => h("td", {}, inline(c)))));
      }
      table.appendChild(body);
      frag.appendChild(h("div", { class: "md-scroll" }, [table]));
      continue;
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const list = h(ordered ? "ol" : "ul");
      for (; i < lines.length; i += 1) {
        const item = (ordered ? NUMBER : BULLET).exec(lines[i]);
        if (!item) break;
        list.appendChild(h("li", {}, inline(item[1])));
      }
      frag.appendChild(list);
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length; i += 1) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        quoted.push(q[1]);
      }
      frag.appendChild(h("blockquote", {}, inline(quoted.join(" "))));
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flush();
  return frag;
}
