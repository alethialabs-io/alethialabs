#!/usr/bin/env node
/**
 * Build the Alethia "Data Room" — a single self-contained, Alethia-styled HTML
 * file that renders every spec/mvp markdown doc (+ competitor deep-dives) with a
 * sidebar to traverse them. Private by control (it's a file you hand out); never
 * published to the public apps/docs site.
 *
 *   node scripts/build-dataroom.mjs       (or: pnpm dataroom)
 *
 * Re-run after editing any .md to regenerate. Output: dataroom/alethia-dataroom.html
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MVP = join(ROOT, "spec", "mvp");
const COMP = join(MVP, "competitors");
const OUT_DIR = join(ROOT, "dataroom");
const OUT = join(OUT_DIR, "alethia-dataroom.html");

marked.setOptions({ gfm: true, breaks: false });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const specNum = (f) => { const m = f.match(/^(\d+)-/); return m ? parseInt(m[1], 10) : 900; };
const titleOf = (md, fb) => { const m = md.match(/^#\s+(.+?)\s*$/m); return (m ? m[1] : fb).replace(/[`*]/g, ""); };

/** Rewrite an internal .md link (relative to the doc's dir) → in-file #doc-<slug> anchor. */
function rewriteHref(href, kind) {
  if (/^(https?:)?\/\//i.test(href) || href.startsWith("mailto:")) return { href, ext: true };
  if (href.startsWith("#")) return { href, ext: false };
  const baseDir = kind === "comp" ? "spec/mvp/competitors" : "spec/mvp";
  let p = posix.normalize(posix.join(baseDir, href.split("#")[0])).replace(/^spec\/mvp\//, "");
  if (p === "competitors" || p === "competitors/") return { href: "#doc-comp-README", ext: false };
  if (!p.endsWith(".md")) return { href, ext: false };
  const b = basename(p, ".md");
  return { href: "#" + (p.startsWith("competitors/") ? "doc-comp-" : "doc-") + b, ext: false };
}

function renderDoc(md, kind) {
  let html = marked.parse(md);
  html = html.replace(/href="([^"]+)"/g, (_m, h) => {
    const r = rewriteHref(h, kind);
    return r.ext ? `href="${r.href}" target="_blank" rel="noopener"` : `href="${r.href}"`;
  });
  return html;
}

// ---- collect docs ----
const specFiles = readdirSync(MVP).filter((f) => f.endsWith(".md")).sort((a, b) => specNum(a) - specNum(b) || a.localeCompare(b));
const compFiles = readdirSync(COMP).filter((f) => f.endsWith(".md")).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));

const docs = [];
for (const f of specFiles) { const md = readFileSync(join(MVP, f), "utf8"); docs.push({ id: "doc-" + basename(f, ".md"), title: titleOf(md, basename(f, ".md")), kind: "spec", file: f, html: renderDoc(md, "spec") }); }
for (const f of compFiles) { const md = readFileSync(join(COMP, f), "utf8"); docs.push({ id: "doc-comp-" + basename(f, ".md"), title: titleOf(md, basename(f, ".md")), kind: "comp", file: f, html: renderDoc(md, "comp") }); }

// ---- sidebar groups ----
function specGroup(f) { if (f.startsWith("A-")) return "Reference"; const n = specNum(f); if (n === 0) return "Overview"; if (n <= 4) return "Product & Market"; if (n <= 11 || n === 18) return "Architecture"; if (n <= 17) return "Business & Fundraising"; return "Reference"; }
const order = ["Overview", "Product & Market", "Architecture", "Business & Fundraising", "Reference", "Competitors"];
const groups = new Map();
for (const d of docs) {
  const g = d.kind === "comp" ? "Competitors" : specGroup(d.file);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(d);
}

const deckLabels = { "pitch-deck": "Pitch Deck", "product-overview": "Product Overview", "one-pager": "One-Pager", "executive-summary": "Executive Summary", "sales-deck": "Sales Deck", "technical-overview": "Technical Overview", "index": "Data-Room Hub" };
const decks = Object.keys(deckLabels).filter((s) => existsSync(join(ROOT, "presentations", s + ".html")));

const navHtml = order.filter((g) => groups.has(g)).map((g) => {
  const items = groups.get(g).map((d) => `<a class="nav-item" href="#${d.id}" data-id="${d.id}">${esc(d.title)}</a>`).join("\n");
  return `<div class="nav-group"><div class="nav-h">${g}</div>\n${items}\n</div>`;
}).join("\n");
const deckNav = decks.length ? `<div class="nav-group"><div class="nav-h">Presentations</div>\n${decks.map((s) => `<a class="nav-item ext" href="../presentations/${s}.html" target="_blank" rel="noopener">${deckLabels[s]} ↗</a>`).join("\n")}\n</div>` : "";

const articles = docs.map((d) => `<article id="${d.id}" class="doc">\n${d.html}\n</article>`).join("\n");

const CSS = `
:root{--g0:oklch(1 0 0);--g50:oklch(.985 0 0);--g200:oklch(.928 0 0);--g400:oklch(.788 0 0);--g500:oklch(.664 0 0);--g600:oklch(.556 0 0);--g700:oklch(.44 0 0);--g950:oklch(.205 0 0);--g1000:oklch(.165 0 0);--g1050:oklch(.13 0 0);--g1100:oklch(.108 0 0);--font-display:"Space Grotesk",system-ui,sans-serif;--font-sans:"Geist",system-ui,-apple-system,sans-serif;--font-mono:"Geist Mono",ui-monospace,monospace;--radius:.5rem;}
html.dark{--canvas:var(--g1050);--surface:var(--g1000);--sunken:var(--g1100);--text:var(--g50);--text-2:var(--g500);--text-3:var(--g600);--border:oklch(1 0 0 / .10);--border-2:oklch(1 0 0 / .16);--accent:var(--g50);}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--canvas);color:var(--text);font-family:var(--font-sans);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;display:flex}
a{color:var(--text);text-decoration:none}
/* sidebar */
.sidebar{width:300px;flex:none;height:100vh;overflow-y:auto;border-right:1px solid var(--border);background:var(--g1100);padding:1.4rem 1rem;position:sticky;top:0}
.brand{font-family:var(--font-display);font-weight:600;font-size:1.25rem;letter-spacing:-.02em}
.eyebrow{font-family:var(--font-mono);font-size:.65rem;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--text-3);margin-top:.2rem}
.filter{width:100%;margin:1rem 0;background:var(--sunken);border:1px solid var(--border-2);border-radius:.375rem;color:var(--text);font-family:var(--font-sans);font-size:.8rem;padding:.45rem .6rem}
.filter::placeholder{color:var(--text-3)}
.nav-group{margin-bottom:1.1rem}
.nav-h{font-family:var(--font-mono);font-size:.62rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--text-3);padding:0 .4rem;margin-bottom:.35rem}
.nav-item{display:block;padding:.32rem .5rem;border-radius:.35rem;color:var(--text-2);font-size:.82rem;line-height:1.3;border:0}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item.active{background:var(--surface);color:var(--text);box-shadow:inset 2px 0 0 var(--accent)}
.nav-item.ext{color:var(--text-3)}
/* content */
.content{flex:1;height:100vh;overflow-y:auto}
.doc{display:none;max-width:50rem;margin:0 auto;padding:3.5rem 3rem 6rem}
.doc h1{font-family:var(--font-display);font-weight:600;font-size:2rem;letter-spacing:-.025em;line-height:1.12;margin:0 0 1.2rem}
.doc h2{font-family:var(--font-display);font-weight:600;font-size:1.4rem;letter-spacing:-.02em;margin:2.4rem 0 .9rem;padding-bottom:.4rem;border-bottom:1px solid var(--border)}
.doc h3{font-family:var(--font-display);font-weight:600;font-size:1.1rem;margin:1.8rem 0 .6rem}
.doc h4{font-weight:600;font-size:.95rem;margin:1.4rem 0 .4rem;color:var(--text)}
.doc p,.doc li{color:var(--text-2)}
.doc p{margin:.7rem 0}
.doc ul,.doc ol{margin:.7rem 0;padding-left:1.3rem}
.doc li{margin:.3rem 0}
.doc strong{color:var(--text);font-weight:600}
.doc a{color:var(--text);text-decoration:underline;text-decoration-color:var(--border-2);text-underline-offset:2px}
.doc a:hover{text-decoration-color:var(--text)}
.doc code{font-family:var(--font-mono);font-size:.85em;background:var(--sunken);border:1px solid var(--border);border-radius:.3rem;padding:.05rem .35rem;color:var(--text)}
.doc pre{background:var(--sunken);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;overflow-x:auto;margin:1rem 0}
.doc pre code{background:none;border:0;padding:0;font-size:.82rem;line-height:1.55}
.doc blockquote{margin:1rem 0;padding:.4rem 0 .4rem 1rem;border-left:2px solid var(--border-2);color:var(--text-2)}
.doc blockquote strong{color:var(--text)}
.doc hr{border:0;border-top:1px solid var(--border);margin:2rem 0}
.doc table{width:100%;border-collapse:collapse;font-size:.85rem;margin:1rem 0;display:block;overflow-x:auto}
.doc th,.doc td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--border);vertical-align:top}
.doc th{font-family:var(--font-mono);font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:500;white-space:nowrap}
.doc td{color:var(--text-2)}.doc td strong{color:var(--text)}
.doc img{max-width:100%}
@media(max-width:820px){body{flex-direction:column}.sidebar{width:100%;height:auto;position:static;border-right:0;border-bottom:1px solid var(--border)}.content{height:auto}.doc{padding:2rem 1.2rem 4rem}}
`;

const JS = `(function(){var docs=[].slice.call(document.querySelectorAll('.doc'));var items=[].slice.call(document.querySelectorAll('.nav-item[data-id]'));var main=document.querySelector('.content');function show(id){var ok=false;docs.forEach(function(d){var on=d.id===id;d.style.display=on?'block':'none';if(on)ok=true;});if(!ok&&docs[0]){docs[0].style.display='block';id=docs[0].id;}items.forEach(function(a){a.classList.toggle('active',a.getAttribute('data-id')===id);});var act=document.querySelector('.nav-item.active');if(act)act.scrollIntoView({block:'nearest'});if(main)main.scrollTop=0;}function fromHash(){var h=(location.hash||'').replace('#','');show(h||(docs[0]&&docs[0].id));}window.addEventListener('hashchange',fromHash);fromHash();var f=document.getElementById('filter');if(f){f.addEventListener('input',function(){var q=f.value.toLowerCase();items.forEach(function(a){a.style.display=a.textContent.toLowerCase().indexOf(q)>-1?'':'none';});document.querySelectorAll('.nav-group').forEach(function(g){var any=[].slice.call(g.querySelectorAll('.nav-item')).some(function(a){return a.style.display!=='none';});g.style.display=any?'':'none';});});}})();`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">';

const html = `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alethia — Data Room</title>
<meta name="robots" content="noindex, nofollow">
${FONTS}
<style>${CSS}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">Alethia</div>
  <div class="eyebrow">Data Room · ${docs.length} docs</div>
  <input id="filter" class="filter" type="text" placeholder="Filter…" autocomplete="off">
  <nav>
${navHtml}
${deckNav}
  </nav>
</aside>
<main class="content">
${articles}
</main>
<script>${JS}</script>
</body>
</html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, "utf8");
console.log(`Data Room built: ${OUT}`);
console.log(`  ${docs.length} docs (${specFiles.length} spec + ${compFiles.length} competitors) · ${decks.length} deck links · ${(html.length / 1024).toFixed(0)} KB`);
