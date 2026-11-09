const MARKER = '<!-- lastgreen-diagnosis -->';

/** Turn the full report into a concise, idempotent pull-request comment. */
export function renderPrComment(report, { artifactUrl = '' } = {}) {
  let markdown = String(report).replaceAll(MARKER, '&lt;!-- lastgreen-diagnosis --&gt;');
  markdown = markdown.replace(/^# [^\n]+\n+/, '').replace(/^Generated: [^\n]+\n+/m, '');
  const configurations = markdown.indexOf('## Configurations tested');
  const changes = configurations === -1 ? -1 : markdown.indexOf('<details><summary>', configurations);
  const reproduce = markdown.indexOf('## Reproduce');
  const summaryEnd = configurations === -1 ? (reproduce === -1 ? markdown.length : reproduce) : configurations;
  let summary = markdown.slice(0, summaryEnd).trim();
  if (summary.length > 35_000) summary = `${summary.slice(0, 35_000)}\n\n…truncated; see the full report.`;
  let table = '';
  if (configurations !== -1) {
    const end = [changes, reproduce].filter((at) => at > configurations).sort((a, b) => a - b)[0] ?? markdown.length;
    table = markdown.slice(configurations, end).replace(/^## Configurations tested\s*/, '').trim();
    if (table.length > 20_000) table = `${table.slice(0, 20_000)}\n\n…truncated; see the full report.`;
  }
  const out = [MARKER, '## lastgreen diagnosis', '', summary];
  if (table) out.push('', '<details><summary>Configurations tested</summary>', '', table, '', '</details>');
  if (artifactUrl) out.push('', `[Download the full diagnosis report](${artifactUrl})`);
  out.push('', '_Updated by lastgreen. Re-running the workflow updates this comment._', '');
  return out.join('\n');
}

export { MARKER as PR_COMMENT_MARKER };
