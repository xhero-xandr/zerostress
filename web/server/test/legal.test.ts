import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownPage } from '../legal.ts';

test('the page escapes everything that is not the Markdown it understands', () => {
  const html = markdownPage('# T <b>\n\nA <script>alert(1)</script> & "q" [x](javascript:alert(1)) [y](https://ok.example/a)\n\n- **b** `c`\n- https://z.example/p.');
  assert.match(html, /<h1>T &lt;b&gt;<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/ok\.example\/a">y<\/a>/);
  assert.match(html, /<ul>\n<li><strong>b<\/strong> <code>c<\/code><\/li>\n<li><a href="https:\/\/z\.example\/p">https:\/\/z\.example\/p<\/a>\.<\/li>\n<\/ul>/);
  assert.match(html, /<title>T &lt;b&gt; · ZeroStress<\/title>/);
});
