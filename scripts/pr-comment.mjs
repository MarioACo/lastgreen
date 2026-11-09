import fs from 'node:fs';
import path from 'node:path';
import { renderPrComment } from '../src/pr-comment.js';

const [input, output, artifactUrl = ''] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: pr-comment.mjs <report.md> <comment.md> [artifact-url]');
const comment = renderPrComment(fs.readFileSync(input, 'utf8'), { artifactUrl });
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, comment);
