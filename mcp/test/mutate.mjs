// Mutation check of the MCP server's tests: break one protective step at a time in a COPY of mcp/ and require that the
// tests fail. A mutation that survives, or whose text is not found exactly once, fails the run.
//   node test/mutate.mjs            all of them
//   node test/mutate.mjs --only=file
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

// [label, file, text to find (exactly once), replacement]
const MUTATIONS = [
  ['file: the folder is not the limit', 'tools.mjs', "if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw", 'if (false) throw'],
  ['file: a link is followed to where it leads, unchecked', 'tools.mjs', "real = await realpath(isAbsolute(requested) ? requested : resolve(root, requested));", "real = isAbsolute(requested) ? requested : resolve(root, requested);"],
  ['file: the kind of file is not checked before it is opened', 'tools.mjs', "if (!(await stat(real).catch(() => null))?.isFile()) throw", 'if (false) throw'],
  ['file: no size limit', 'tools.mjs', 'if (total > FILE_MAX_BYTES) throw', 'if (false) throw'],
  ['file: an empty file is sent', 'tools.mjs', 'if (total === 0) throw', 'if (false) throw'],
  ['file: the tool works with no folder named', 'tools.mjs', "if (!dir) throw new ToolError('Checking files is off.", "if (false) throw new ToolError('Checking files is off."],
  ['file: the name is sent as it is', 'tools.mjs', "'x-file-name': encodeURIComponent(name)", "'x-file-name': name"],
  ['arguments: unknown ones are accepted', 'tools.mjs', "Object.keys(a).some((k) => !keys.includes(k))", 'false'],
  ['arguments: a link of any length', 'tools.mjs', "a.url.length === 0 || a.url.length > 2048", 'false'],
  ['arguments: an email of any number of links', 'tools.mjs', "a.links.length === 0 || a.links.length > 30 ||", ''],
  ['arguments: any id is asked for', 'tools.mjs', "if (typeof a.id !== 'string' || !ID.test(a.id)) throw", 'if (false) throw'],
  ['service: an id that is not one is put in an address', 'tools.mjs', "if (!d || typeof d.id !== 'string' || !ID.test(d.id)) throw", 'if (false) throw'],
  ['service: a redirect is followed', 'tools.mjs', "redirect: 'error'", "redirect: 'follow'"],
  ['service: the service\'s own words are repeated', 'tools.mjs', "const code = typeof data?.code === 'string' && CODE.test(data.code) ? data.code : `http_${res.status}`;", "const code = String(data?.code ?? `http_${res.status}`);"],
  ['service: the time to wait is not told', 'tools.mjs', "const wait = Number.isFinite(retry) && retry > 0 ?", "const wait = false ?"],
  ['service: no user agent', 'tools.mjs', "'user-agent': `zerostress-mcp/${version}`, ", ''],
  ['result: a verdict of any kind', 'tools.mjs', "const verdict = VERDICTS.has(report?.verdict) ? report.verdict : 'unknown';", "const verdict = report?.verdict;"],
  ['result: signals of any id', 'tools.mjs', "report.signals.filter((s) => s && CODE.test(s.id) && LEVELS.has(s.level))", 'report.signals'],
  ['result: signals of any level', 'tools.mjs', ' && LEVELS.has(s.level)', ''],
  ['result: findings of any kind', 'tools.mjs', "list.filter((x) => typeof x === 'string' && CODE.test(x))", 'list'],
  ['result: control characters stay', 'tools.mjs', "const s = v.replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]/g, ' ').trim();", 'const s = v.trim();'],
  ['result: text of any length', 'tools.mjs', 'return s.length > max ?', 'return false ?'],
  ['result: any number of reasons', 'tools.mjs', 'report.reasons.slice(0, 8)', 'report.reasons'],
  ['result: the page\'s summary outside the untrusted block', 'tools.mjs', "    injection_attempt: report?.injection_attempt === true,\n", "    injection_attempt: report?.injection_attempt === true,\n    summary: plain(report?.summary),\n"],
  ['result: the label VirusTotal gave is passed on', 'tools.mjs', "total: num(report.file.virustotal.total, 0, 1e6, 0) }", "total: num(report.file.virustotal.total, 0, 1e6, 0), label: report.file.virustotal.label }"],
  ['result: a person is not waited for', 'tools.mjs', "if (st?.awaiting === true) return", "if (false) return"],
  ['result: a failed check without a report looks done', 'tools.mjs', "if (st.has_report !== true) return { state: 'failed'", "if (false) return { state: 'failed'"],
  ['service: a key is sent along', 'tools.mjs', "accept: 'application/json' };", "accept: 'application/json', 'x-task-key': 'k' };"],
  ['protocol: any version is echoed', 'server.mjs', 'protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],', 'protocolVersion: asked,'],
  ['protocol: a notification is answered', 'server.mjs', 'if (id === undefined) return;', ''],
  ['protocol: an unknown tool is called', 'server.mjs', "if (!tool) return fail(id, -32602, 'Unknown tool');", 'if (!tool) return reply(id, { content: [], isError: false });'],
  ['protocol: an error of the program is passed on in its words', 'server.mjs', "e instanceof ToolError ? e.message : 'The check failed.'", 'String(e?.message ?? e)'],
  ['config: an address that is not https is accepted', 'server.mjs', "if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw", 'if (false) throw'],
];

let failed = false;
let run = 0;
for (const [label, file, from, to] of MUTATIONS) {
  if (only && !label.includes(only)) continue;
  run++;
  const dir = mkdtempSync(join(tmpdir(), 'zs-mcp-mut-'));
  try {
    cpSync(here, dir, { recursive: true, filter: (p) => !p.includes('node_modules') });
    const text = readFileSync(join(dir, file), 'utf8');
    const n = text.split(from).length - 1;
    if (n !== 1) { console.log(`\nNOT FOUND (${n}x): ${label}`); failed = true; continue; }
    writeFileSync(join(dir, file), text.replace(from, () => to));
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/server.test.mjs', 'test/shape.test.mjs'], { cwd: dir, timeout: 150_000, encoding: 'utf8' });
    const caught = r.status !== 0;
    process.stdout.write(caught ? '.' : 'S');
    if (!caught) { console.log(`\nSURVIVED: ${label}`); failed = true; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\nmutations: ${run}${failed ? ', see above' : ', all caught'}`);
process.exit(failed ? 1 : 0);
