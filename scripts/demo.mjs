// Renders the README demo from one script: the real chalk 4 -> 5 session
// (same versions, same output as running it for real), as
//   assets/demo.svg                       animated SVG for the README
//   <out>/demo.mp4 and <out>/demo.gif     for social posts (needs Edge + ffmpeg)
//
//   node scripts/demo.mjs                 writes assets/demo.svg
//   node scripts/demo.mjs --video <out>   also renders frames, MP4 and GIF
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = { bg: '#0d1117', bar: '#161b22', fg: '#c9d1d9', dim: '#8b949e', green: '#3fb950', red: '#f85149', cyan: '#79c0ff', yellow: '#d29922', white: '#f0f6fc', prompt: '#7ee787' };

// [kind, segments, extra pause before (s)]. "cmd" lines are typed.
const S = (text, color = C.fg, bold = false) => ({ text, color, bold });
const SCRIPT = [
  ['cmd', [S('npx lastgreen run -- npm test')], 0.4],
  ['out', [S('ok: colors work', C.dim)], 0.5],
  ['out', [S('lastgreen ', C.dim), S('✓', C.green), S(' green saved · 11 packages · Node v24.16.0', C.fg)], 0.2],
  ['gap', [], 0.3],
  ['cmd', [S('npm install chalk@5.3.0 debug@4.4.0 ms@2.1.3 semver@7.6.3')], 0.9],
  ['out', [S('removed 7 packages, and changed 4 packages in 616ms', C.dim)], 0.6],
  ['cmd', [S('npx lastgreen run -- npm test')], 0.5],
  ['out', [S('TypeError: chalk.green is not a function', C.red)], 0.5],
  ['out', [S('lastgreen ', C.dim), S('✗', C.red), S(' failed · 13 changes since the last green: chalk 4.1.2 → 5.3.0, debug…', C.fg)], 0.2],
  ['gap', [], 0.3],
  ['cmd', [S('npx lastgreen why')], 0.9],
  ['out', [S('Finding the culprit among 11 changes with `npm test`', C.white, true)], 0.6],
  ['out', [S('  #1  ', C.dim), S('✗ fail', C.red), S('   current environment')], 0.45],
  ['out', [S('  #2  ', C.dim), S('✓ pass', C.green), S('   last green environment')], 0.45],
  ['out', [S('  #3  ', C.dim), S('✗ fail', C.red), S('   7 of 11 changes')], 0.45],
  ['out', [S('  #4  ', C.dim), S('✗ fail', C.red), S('   4 of 11 changes')], 0.45],
  ['out', [S('  #5  ', C.dim), S('✗ fail', C.red), S('   3 of 11 changes')], 0.45],
  ['out', [S('  #6  ', C.dim), S('✗ fail', C.red), S('   only: chalk 4.1.2 → 5.3.0')], 0.45],
  ['out', [S('  #7  ', C.dim), S('✓ pass', C.green), S('   all except: chalk')], 0.45],
  ['gap', [], 0.2],
  ['out', [S('✓ Culprit confirmed: ', C.green, true), S('chalk 4.1.2 → 5.3.0', C.white, true)], 0.5],
  ['out', [S('  undoing only this makes `npm test` pass; keeping only this makes it fail', C.dim)], 0.3],
  ['gap', [], 0.1],
  ['out', [S('  Where it breaks in your code', C.white, true)], 0.5],
  ['out', [S('    test.js:5', C.cyan), S("  console.log(chalk.green('ok: ') + 'colors work');", C.dim)], 0.3],
  ['out', [S('  How your code uses chalk', C.white, true)], 0.4],
  ['out', [S('    test.js:1', C.cyan), S("  const chalk = require('chalk');", C.dim)], 0.3],
  ['out', [S('  What changed in chalk 4.1.2 → 5.3.0', C.white, true), S(' (GitHub release notes)', C.dim)], 0.5],
  ['out', [S('    5.0.0  ', C.dim), S('⚠ ', C.yellow), S('This package is now pure ESM. Please read this.')], 0.3],
  ['out', [S('    5.0.0  ', C.dim), S('⚠ ', C.yellow), S('Move some properties off the default export to named exports')], 0.3],
  ['gap', [], 0.1],
  ['out', [S('Fix', C.white, true), S('   to go back now:   ', C.dim), S('npm install --save-exact chalk@4.1.2', C.cyan)], 0.5],
  ['out', [S('      or to move forward: ', C.dim), S('update test.js:5 for chalk 5.3.0', C.cyan)], 0.3],
  ['out', [S('7 runs · 4.0 s · node_modules restored and verified', C.green)], 0.4],
];
const HOLD = 6; // seconds the final screen stays
const TYPE = 0.035; // seconds per typed character

const W = 900;
const LH = 21;
const PAD = 22;
const BAR = 38;
const FONT = 14;
const CHAR = 8.43; // advance of a 14px monospace glyph
const H = BAR + PAD * 2 + SCRIPT.length * LH;

// Timeline: when each line (and each typed character) appears.
const timeline = [];
let t = 0;
for (const [kind, segs, pause] of SCRIPT) {
  t += pause;
  if (kind === 'cmd') {
    const text = segs.map((s) => s.text).join('');
    const chars = [...text].map((ch, i) => ({ ch, at: t + 0.15 + i * TYPE }));
    timeline.push({ kind, segs, at: t, chars });
    t += 0.15 + text.length * TYPE + 0.25;
  } else {
    timeline.push({ kind, segs, at: t });
  }
}
const TOTAL = t + HOLD;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (sec) => ((sec / TOTAL) * 100).toFixed(3);

function frame(time) {
  // time === null -> animated (CSS); otherwise a still of that moment.
  const css = [];
  const body = [];
  let kf = 0;
  const anim = (at) => {
    const name = `a${kf++}`;
    css.push(`@keyframes ${name}{0%,${pct(at)}%{opacity:0}${pct(at + 0.001)}%,98.5%{opacity:1}100%{opacity:0}}`);
    return `style="animation:${name} ${TOTAL.toFixed(2)}s linear infinite"`;
  };
  timeline.forEach((line, i) => {
    const y = BAR + PAD + LH * i + 15;
    if (line.kind === 'gap') return;
    if (line.kind === 'cmd') {
      const shown = time === null ? line.chars : line.chars.filter((c) => c.at <= time);
      if (time !== null && line.at > time) return;
      const promptAttr = time === null ? anim(line.at) : '';
      const chars = shown
        .map((c) => (time === null ? `<tspan ${anim(c.at)}>${esc(c.ch)}</tspan>` : esc(c.ch)))
        .join('');
      body.push(`<text x="${PAD}" y="${y}"><tspan fill="${C.prompt}" font-weight="bold" ${promptAttr}>$ </tspan><tspan fill="${C.fg}">${chars}</tspan></text>`);
      return;
    }
    if (time !== null && line.at > time) return;
    const segs = line.segs.map((s) => `<tspan fill="${s.color}"${s.bold ? ' font-weight="bold"' : ''}>${esc(s.text)}</tspan>`).join('');
    body.push(`<text x="${PAD}" y="${y}" ${time === null ? anim(line.at) : ''}>${segs}</text>`);
  });
  // Blinking cursor after the last typed character visible (stills only).
  if (time !== null) {
    const last = [...timeline.entries()].filter(([, l]) => l.kind === 'cmd' && l.at <= time).pop();
    if (last) {
      const [i, l] = last;
      const typed = l.chars.filter((c) => c.at <= time).length;
      if (typed < l.chars.length) {
        body.push(`<rect x="${PAD + CHAR * (2 + typed)}" y="${BAR + PAD + LH * i + 2}" width="${CHAR}" height="17" fill="${C.fg}" opacity="0.8"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="lastgreen finds that chalk 4.1.2 to 5.3.0 broke npm test">
<style>text{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:${FONT}px;white-space:pre}${css.join('')}</style>
<rect width="${W}" height="${H}" rx="10" fill="${C.bg}"/>
<path d="M0 10a10 10 0 0 1 10-10h${W - 20}a10 10 0 0 1 10 10v${BAR - 10}H0z" fill="${C.bar}"/>
<circle cx="20" cy="19" r="6" fill="#ff5f57"/><circle cx="40" cy="19" r="6" fill="#febc2e"/><circle cx="60" cy="19" r="6" fill="#28c840"/>
<text x="${W / 2}" y="24" text-anchor="middle" fill="${C.dim}" style="font-size:12px">~/my-app — lastgreen</text>
${body.join('\n')}
</svg>
`;
}

const assets = path.join(here, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'demo.svg'), frame(null));
console.log(`assets/demo.svg  ${W}x${H}, ${TOTAL.toFixed(1)} s loop`);

const vi = process.argv.indexOf('--video');
if (vi !== -1) {
  const out = path.resolve(process.argv[vi + 1] ?? 'demo-out');
  const framesDir = path.join(out, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome']
    .find((p) => fs.existsSync(p));
  if (!edge) throw new Error('Edge/Chrome not found');
  // Change points: every moment something new appears.
  const points = [0, ...timeline.flatMap((l) => (l.chars ? [l.at, ...l.chars.filter((_, i) => i % 2 === 1).map((c) => c.at)] : [l.at]))].sort((a, b) => a - b);
  // 4:5 portrait: what LinkedIn and X show best in a phone feed.
  const VW = 1080;
  const VH = 1350;
  const scale = Math.min((VW - 60) / W, (VH - 230) / H);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-edge-'));
  const list = [];
  points.forEach((at, i) => {
    const svg = frame(at + 0.0005);
    const html = `<!doctype html><html><body style="margin:0;width:${VW}px;height:${VH}px;background:radial-gradient(circle at 30% 15%,#1b2a1f,#0b0f14 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<div style="color:#f0f6fc;font-size:46px;font-weight:700;margin-bottom:8px">last<span style="color:#3fb950">green</span></div>
<div style="color:#c9d1d9;font-size:25px;margin-bottom:6px">It passed yesterday. Today it fails.</div>
<div style="color:#8b949e;font-size:21px;margin-bottom:26px">Which change broke it, where, and what to change. Proved.</div>
<div style="width:${W * scale}px;height:${H * scale}px;box-shadow:0 20px 60px rgba(0,0,0,.6);border-radius:12px">${svg.replace('<svg ', `<svg style="width:${W * scale}px;height:${H * scale}px" `)}</div>
</body></html>`;
    const htmlFile = path.join(framesDir, `f${String(i).padStart(4, '0')}.html`);
    const png = htmlFile.replace(/\.html$/, '.png');
    fs.writeFileSync(htmlFile, html);
    for (let attempt = 0; attempt < 3 && !fs.existsSync(png); attempt++) {
      spawnSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--window-size=${VW},${VH}`, `--screenshot=${png}`, `file:///${htmlFile.replace(/\\/g, '/')}`], { stdio: 'ignore', timeout: 30_000 });
    }
    const next = points[i + 1] ?? at + HOLD;
    list.push(`file '${png.replace(/\\/g, '/')}'`, `duration ${Math.max(next - at, 0.02).toFixed(3)}`);
  });
  list.push(`file '${path.join(framesDir, `f${String(points.length - 1).padStart(4, '0')}.png`).replace(/\\/g, '/')}'`);
  fs.writeFileSync(path.join(framesDir, 'list.txt'), list.join('\n'));
  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  };
  const concat = ['-f', 'concat', '-safe', '0', '-i', path.join(framesDir, 'list.txt')];
  ff([...concat, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', path.join(out, 'demo.mp4')]);
  ff([...concat, '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none', path.join(out, 'demo.gif')]);
  fs.copyFileSync(path.join(framesDir, `f${String(points.length - 1).padStart(4, '0')}.png`), path.join(out, 'demo-final.png'));
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`${points.length} frames -> ${out}/demo.mp4, demo.gif, demo-final.png`);
}
