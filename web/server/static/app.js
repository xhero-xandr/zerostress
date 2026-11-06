// The page's own script. It writes to the page only with textContent and attributes of ours: it never turns text into
// markup and never runs text as code (a test searches this file for the calls that would). The key of a task lives in the address after the "#", so it never reaches our
// server in a request line, a log or a Referer.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var keyOf = function () {
    var m = /(?:^|[#&])k=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
    return m ? m[1] : '';
  };

  // ---- the home page ----
  var form = $('check-form');
  if (form) {
    var input = $('url');
    var go = $('go');
    var err = $('form-error');
    document.querySelectorAll('[data-fill]').forEach(function (b) {
      b.addEventListener('click', function () { input.value = b.getAttribute('data-fill') || ''; input.focus(); });
    });
    var fail = function (text) { err.textContent = text; err.hidden = false; go.disabled = false; go.textContent = go.getAttribute('data-label') || go.textContent; };
    go.setAttribute('data-label', go.textContent);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.hidden = true;
      go.disabled = true;
      go.textContent = go.getAttribute('data-busy') || '…';
      fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: input.value, deep: $('deep').checked }),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (x) {
        if (x.ok && /^[0-9a-f]{32}$/.test(x.j.id) && /^[A-Za-z0-9_-]{20,100}$/.test(x.j.key)) {
          location.assign('/r/' + x.j.id + '#k=' + x.j.key);
        } else {
          fail(typeof x.j.message === 'string' ? x.j.message : '');
        }
      }).catch(function () { fail(''); });
    });
  }

  // ---- a task page ----
  var id = document.body.getAttribute('data-task') || '';
  if (!/^[0-9a-f]{32}$/.test(id)) return;

  if (document.body.getAttribute('data-live')) {
    var label = $('stage-label');
    var steps = document.querySelectorAll('[data-step]');
    var es = new EventSource('/api/tasks/' + id + '/events');
    es.addEventListener('stage', function (e) {
      var d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (typeof d.label === 'string') label.textContent = d.label;
      if (typeof d.at === 'number') {
        steps.forEach(function (li, i) { li.className = i < d.at ? 'done' : i === d.at ? 'now' : ''; });
      }
    });
    es.addEventListener('final', function () { es.close(); location.reload(); });
  }

  var copy = $('copy');
  if (copy) {
    copy.addEventListener('click', function () {
      var url = location.origin + location.pathname;
      var done = function () { var t = copy.textContent; copy.textContent = copy.getAttribute('data-done') || t; setTimeout(function () { copy.textContent = t; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () {});
    });
  }

  // ---- Explain and questions ----
  // Answers are shown with textContent only. The first open asks for the explanation by itself.
  var chat = $('chat');
  var openBtn = $('explain-open');
  if (chat && openBtn) {
    var log = $('chat-log');
    var cform = $('chat-form');
    var cinput = $('chat-input');
    var csend = $('chat-send');
    var started = false;
    var busy = false;
    var bubble = function (who, text) {
      var d = document.createElement('div');
      d.className = 'msg ' + who;
      var p = document.createElement('p');
      p.textContent = text;
      d.appendChild(p);
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    };
    var ask = function (payload, shown) {
      if (busy) return;
      busy = true;
      csend.disabled = true;
      if (shown) bubble('me', shown);
      var wait = bubble('bot wait', chat.getAttribute('data-thinking') || '…');
      fetch('/api/reports/' + id + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (x) {
        wait.className = 'msg bot';
        var p = wait.firstChild;
        if (x.ok && typeof x.j.text === 'string') {
          p.textContent = x.j.text;
          var src = document.createElement('small');
          src.className = 'muted';
          src.textContent = chat.getAttribute(x.j.source === 'model' ? 'data-model' : 'data-rules') || '';
          wait.appendChild(src);
          if (typeof x.j.note === 'string' && x.j.note) {
            var n = document.createElement('small');
            n.className = 'muted';
            n.textContent = x.j.note;
            wait.appendChild(n);
          }
        } else {
          p.textContent = typeof x.j.message === 'string' ? x.j.message : (chat.getAttribute('data-failed') || '');
        }
      }).catch(function () {
        wait.className = 'msg bot';
        wait.firstChild.textContent = chat.getAttribute('data-failed') || '';
      }).then(function () { busy = false; csend.disabled = false; log.scrollTop = log.scrollHeight; });
    };
    var setOpen = function (on) {
      chat.hidden = !on;
      openBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        if (!started) {
          started = true;
          // like a person attaching what they are looking at: the screenshot first, then the request
          if (chat.getAttribute('data-shot')) {
            var pic = document.createElement('div');
            pic.className = 'msg me';
            var img = document.createElement('img');
            img.src = '/r/' + id + '/screenshot.png';
            img.alt = chat.getAttribute('data-alt') || '';
            img.width = 240;
            pic.appendChild(img);
            log.appendChild(pic);
          }
          ask({ kind: 'explain' }, chat.getAttribute('data-explain') || '');
        }
        cinput.focus();
      } else {
        openBtn.focus();
      }
    };
    openBtn.addEventListener('click', function () { setOpen(chat.hidden); });
    $('chat-close').addEventListener('click', function () { setOpen(false); });
    chat.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    cform.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = cinput.value.trim();
      if (!q || busy) return;
      cinput.value = '';
      ask({ kind: 'ask', message: q }, q);
    });
  }

  // ---- the owner's decision ----
  var box = $('approval');
  var key = keyOf();
  if (box && key) {
    fetch('/api/tasks/' + id + '/pending', { headers: { 'x-task-key': key } }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j || !j.pending || !j.pending.length) return;
      var p = j.pending[0];
      $('approval-what').textContent = typeof p.label === 'string' ? p.label : '';
      box.hidden = false;
      var guest = $('approval-guest');
      if (guest) guest.hidden = true;
      var decide = function (allow) {
        $('allow').disabled = true;
        $('deny').disabled = true;
        fetch('/api/tasks/' + id + '/approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-task-key': key },
          body: JSON.stringify({ command_id: p.command_id, command_sha256: p.command_sha256, allow: allow }),
        }).then(function (r) { return r.json(); }).then(function (res) {
          $('approval-result').textContent = typeof res.message === 'string' ? res.message : '';
        }).catch(function () { $('approval-result').textContent = ''; });
      };
      $('allow').addEventListener('click', function () { decide(true); });
      $('deny').addEventListener('click', function () { decide(false); });
    }).catch(function () {});
  }
})();
