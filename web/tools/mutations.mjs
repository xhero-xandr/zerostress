// Mutations of the hooks, for tools/mutate.mjs. Each one breaks one protective step; a test must then fail.
// [label, file, text to find (exactly once), replacement, test files (default: hooks.test.ts)]
const HOOKS = ['hooks/test/hooks.test.ts'];
const GUARDED = ['hooks/test/guarded.test.ts'];

export const MUTATIONS = [
  // normalisation
  ['no invisible-character removal', 'hooks/normalize.ts', 'if (IGNORABLE.test(ch)) continue;', ''],
  ['no combining-mark removal', 'hooks/normalize.ts', 'if (decompose && MARK.test(c)) continue;', ''],
  ['no lookalike folding', 'hooks/normalize.ts', 'const TO_LATIN: Record<string, string> = {', 'const TO_LATIN: Record<string, string> = {} as Record<string, string>; const UNUSED_LATIN: Record<string, string> = {'],
  ['no leet folding', 'hooks/normalize.ts', 'return LEET[l] ?? l;', 'return l;'],
  ['no cyrillic folding', 'hooks/normalize.ts', 'return TO_CYRILLIC[c] ?? c;', 'return c;'],
  ['no lowercase', 'hooks/normalize.ts', 'for (const lc of c.toLowerCase())', 'for (const lc of c)'],
  ['no whitespace collapse', 'hooks/normalize.ts', "if (last >= 0 && (chars[last] === ' ' || chars[last] === '\\n')) {", 'if (false) {'],
  ['rot13 broken', 'hooks/normalize.ts', '+ 13) % 26', '+ 0) % 26'],
  ['reversed broken', 'hooks/normalize.ts', "text: [...v.text].reverse().join('')", 'text: v.text'],
  ['squash keeps everything', 'hooks/normalize.ts', 'if (/[\\p{L}\\p{N}]/u.test(c)) {', 'if (true) {'],
  // decoding layers
  ['no percent decoding', 'hooks/decode.ts', "if (c === '%' &&", 'if (false &&'],
  ['no entity decoding', 'hooks/decode.ts', "if (c === '&') {", 'if (false) {'],
  ['no escape decoding', 'hooks/decode.ts', "if (c === '\\\\') {", 'if (false) {'],
  ['no base64 tokens', 'hooks/decode.ts', 'for (const m of src.matchAll(B64)) {', 'for (const m of []) {'],
  ['no tag-character tokens', 'hooks/decode.ts', 'for (const m of src.matchAll(TAGS)) {', 'for (const m of []) {'],
  // activation
  ['one core kind fires alone', 'hooks/rules.ts', 'return core >= 2 ||', 'return core >= 1 ||'],
  ['two core kinds never fire', 'hooks/rules.ts', 'return core >= 2 ||', 'return false ||'],
  ['pressure kinds count as core', 'hooks/rules.ts', 'if (SUPPORT.has(k)) support = true;\n    else core++;', 'core++;'],
  ['address + pressure does not fire', 'hooks/rules.ts', "(kinds.has('address') && support)", 'false'],
  // scanning one string
  ['no unescape layer', 'hooks/scan.ts', 'if (un && un.text.length <= MAX_STRING)', 'if (false)'],
  ['no encoded-token layer', 'hooks/scan.ts', 'if (layer < MAX_DEPTH) {', 'if (false) {'],
  ['cut only the match, not the line', 'hooks/scan.ts', 'return [ls, le];', 'return [s, e];'],
  ['no sentence fallback', 'hooks/scan.ts', 'if (le - ls <= 800) return [ls, le];', 'return [ls, le];'],
  ['no squashed phrases', 'hooks/scan.ts', 'const v = views.get(name);\n    if (!v.text) continue;\n    for (const p of phrases) {', 'const v = views.get(name);\n    for (const p of []) {'],
  ['weak kinds of a fired string are kept', 'hooks/scan.ts', 'weak: findings.length ? [] : [...weakKindsOf(found)]', 'weak: []'],
  ['no overflow handling', 'hooks/scan.ts', 'if (found.length >= MAX_HITS) {', 'if (false) {'],
  ['no oversize handling', 'hooks/scan.ts', 'if (src.length > MAX_STRING) {', 'if (false) {'],
  ['no merge of overlapping cuts', 'hooks/scan.ts', 'if (last && s <= last.e) {', 'if (false) {'],
  // the task
  ['no accumulation across events', 'hooks/hooks.ts', 'if (!accumulated && weakActivates(new Set(taskWeak.keys()))) {', 'if (false) {'],
  ['accumulation reported every time', 'hooks/hooks.ts', '          accumulated = true;\n', ''],
  ['structural keys always exempt', 'hooks/hooks.ts', 'STRUCTURAL.has(k) && structuralOk(k, v)) {\n          out[k] = v;', 'STRUCTURAL.has(k)) {\n          out[k] = v;'],
  ['object keys not inspected', 'hooks/hooks.ts', 'const key = scanString(`${here}#key`, k);', 'const key = { findings: [] as never[] };'],
  ['never sticky', 'hooks/hooks.ts', 'if (fs.length) triggered = true;', ''],
  ['depth limit off', 'hooks/hooks.ts', 'if (depth > MAX_DEPTH) {\n      findings.push', 'if (false) {\n      findings.push'],
  ['error path passes the event', 'hooks/hooks.ts', 'return { event: withholdEvent(event), findings: f };', 'return { event, findings: f };'],
  ['error path does not count', 'hooks/hooks.ts', 'const f = [errorFinding(\'event\')];\n        keep(f);', 'const f = [errorFinding(\'event\')];'],
  ['mode stays model', 'hooks/hooks.ts', "mode: triggered ? 'rules_only' : 'model',", "mode: 'model',"],
  ['confirmation not required', 'hooks/hooks.ts', 'require_confirmation: triggered,', 'require_confirmation: false,'],
  // the guarded thread (the deadline, the crashes, the state it keeps)
  ['no deadline', 'hooks/guarded.ts', "const timer = setTimeout(() => fail('hook_timeout'), timeoutMs);", "const timer = setTimeout(() => fail('hook_timeout'), 600_000);", GUARDED],
  ['a late thread is not killed', 'hooks/guarded.ts', '          void w.terminate();\n        }\n        resolve(r);', '        }\n        resolve(r);', GUARDED],
  ['a failed event is passed on', 'hooks/guarded.ts', "const fail = (rule: string) => finish({ event: withholdEvent(event),", 'const fail = (rule: string) => finish({ event,', GUARDED],
  ['a failure is forgotten', 'hooks/guarded.ts', 'return makeState(last.triggered || forced, findings);', 'return makeState(last.triggered, findings);', GUARDED],
  ['a reply to another request is accepted', 'hooks/guarded.ts', 'if (m.id !== id) return;', '', GUARDED],
  ['crashes are not noticed', 'hooks/guarded.ts', "w.on('error', onError);\n      w.on('exit', onExit);", '', GUARDED],
  ['no size limit', 'hooks/guarded.ts', 'if (size > maxEventBytes) return', 'if (false) return', GUARDED],
  ['a closed instance still works', 'hooks/guarded.ts', 'if (closed) return Promise.resolve(', 'if (false) return Promise.resolve(', GUARDED],
  ['start-up counted against the event', 'hooks/guarded.ts', 'if (!(await s.ready)) {', 'if (false) {', GUARDED],
  ['no boot limit', 'hooks/guarded.ts', 'const timer = setTimeout(() => done(false), bootMs);', 'const timer = setTimeout(() => done(false), 600_000);', GUARDED],
  ['the thread is not warmed up', 'hooks/worker.ts', 'warmUp();\n', '', GUARDED],
].map(([label, file, from, to, tests]) => ({ label, file, from, to, tests: tests ?? HOOKS }));
