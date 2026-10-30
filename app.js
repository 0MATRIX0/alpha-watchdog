/* Alpha Watchdog · Support Assistant — UI controller.
 * All text is rendered with textContent / createElement; no HTML-string parsing or dynamic code.
 * Replies are always ids into AW_KB.replies; user text is never echoed into a reply. */
(function () {
  'use strict';

  var KB = window.AW_KB || null;
  var ENGINE = window.AW_ENGINE || null;

  var VERSION = (KB && KB.VERSION) || 'v1.0';
  var MASK_TEXT = '🔒 [hidden for your safety]';
  var CONTACT_QUESTION = 'How can I contact Team Alpha?';
  var FALLBACK_ERROR = 'The response failed. Please retry.';
  var API_TIMEOUT_MS = 6000;
  var MIN_TYPING_MS = 300;
  var WORD_MS = 25;
  var REVEAL_CAP_MS = 900;
  var FLOOD_LOCK_MS = 3000;
  var COUNTER_AT = 400;
  var MAX_CHARS = 500;
  var MAX_IDS = 2;
  var TAG_LABEL = { approved: '✓ Approved answer', safety: '🛡 Safety check' };
  var META = {
    claude: {
      long: VERSION + " · Powered by Claude · Answers come only from Team Alpha's approved list",
      short: VERSION + ' · Powered by Claude'
    },
    rules: {
      long: VERSION + " · Offline mode · built-in matching · Answers come only from Team Alpha's approved list",
      short: VERSION + ' · Offline mode'
    }
  };

  // Used only if knowledge.js failed to load, so the welcome screen still renders.
  var DEFAULT_TOPICS = [
    { id: 'how_it_works', title: 'How it works', hint: 'From spotting a device to a one-tap fix', hintShort: 'Spot it, explain it, fix it', question: 'How does it work?' },
    { id: 'problem', title: 'The problem', hint: 'Why millions of smart devices get hijacked', hintShort: 'Hijacked smart devices', question: 'What problem does it solve?' },
    { id: 'privacy', title: 'Privacy', hint: 'What it reads, and what it never touches', hintShort: 'What it never reads', question: 'Will it read my data?' },
    { id: 'pricing', title: 'Pricing', hint: "What we're planning", hintShort: "What we're planning", question: 'How much does it cost?' },
    { id: 'competitors', title: 'Competitors', hint: 'vs NETGEAR, eero, Firewalla, Fing', hintShort: 'NETGEAR, eero, more', question: 'Who are your competitors?' },
    { id: 'warning_signs', title: 'Warning signs', hint: 'Is my device acting hijacked?', hintShort: 'Is my device hijacked?', question: 'What are the warning signs of a hijacked device?' },
    { id: 'research', title: 'Our research', hint: 'Why we chose cybersecurity', hintShort: 'Why cybersecurity', question: 'What research did your team do?' },
    { id: 'team', title: 'The team', hint: 'Who built Alpha Watchdog', hintShort: 'Who built it', question: 'Who built Alpha Watchdog?' }
  ];

  /* ---------- SVG icons (built with createElementNS) ---------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SHIELD_D = 'M12 2.2l8 3v6.1c0 5-3.4 9.3-8 10.9-4.6-1.6-8-5.9-8-10.9V5.2l8-3z';
  var EYE_D = 'M6.6 12.2c1.4-2.3 3.2-3.4 5.4-3.4s4 1.1 5.4 3.4c-1.4 2.3-3.2 3.4-5.4 3.4s-4-1.1-5.4-3.4z';
  var TOPIC_ICONS = {
    how_it_works: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1' }]],
    problem: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.8v5M12 16.2h.01' }]],
    privacy: [['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
    pricing: [['path', { d: 'M3.8 12.6V4.5a.7.7 0 0 1 .7-.7h8.1l7.6 7.6a1 1 0 0 1 0 1.4l-6.8 6.8a1 1 0 0 1-1.4 0z' }], ['circle', { cx: 8.3, cy: 8.3, r: 1.3 }]],
    competitors: [['path', { d: 'M4 8h14M14.5 4.5 18 8l-3.5 3.5M20 16H6M9.5 12.5 6 16l3.5 3.5' }]],
    warning_signs: [['path', { d: 'M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4.2M12 17h.01' }]],
    research: [['path', { d: 'M4 20h16M7 16.5v-5M12 16.5V6.5M17 16.5v-8' }]],
    team: [['circle', { cx: 9, cy: 8.5, r: 3.2 }], ['path', { d: 'M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.8.6 3 2.2 3.5 4.7' }]]
  };

  function svgEl(size, cls) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    return s;
  }

  function svgShape(parent, tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    parent.appendChild(node);
    return node;
  }

  function topicIcon(id) {
    var s = svgEl(16, 'ico');
    (TOPIC_ICONS[id] || TOPIC_ICONS.how_it_works).forEach(function (p) { svgShape(s, p[0], p[1]); });
    return s;
  }

  function logoIcon(size) {
    var s = svgEl(size, 'logo');
    svgShape(s, 'path', { d: SHIELD_D, 'class': 'logo-shield' });
    svgShape(s, 'path', { d: EYE_D, 'class': 'logo-eye' });
    svgShape(s, 'circle', { cx: 12, cy: 12.2, r: 1.9, 'class': 'logo-pupil' });
    return s;
  }

  /* ---------- DOM helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
  }

  function media(q) {
    return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: function () {} };
  }

  var html = document.documentElement;
  var els = {
    scroller: $('scroller'),
    welcome: $('welcome'),
    welcomeTitle: $('welcome-title'),
    welcomeText: $('welcome-text'),
    cards: $('cards'),
    thread: $('thread'),
    form: $('composer'),
    input: $('composer-input'),
    send: $('send-btn'),
    count: $('char-count'),
    metaLong: $('meta-long'),
    metaShort: $('meta-short'),
    contact: $('contact-btn'),
    theme: $('theme-btn'),
    download: $('download-btn'),
    newChat: $('newchat-btn'),
    more: $('more-btn'),
    menu: $('more-menu'),
    menuDownload: $('menu-download'),
    menuNewChat: $('menu-newchat')
  };

  var mqReduce = media('(prefers-reduced-motion: reduce)');
  var mqDark = media('(prefers-color-scheme: dark)');
  var mqCoarse = media('(pointer: coarse)');

  /* ---------- State ---------- */

  var state = freshState();
  var session = 0;              // bumps on New chat; stale turns check it and stop
  var queue = Promise.resolve(); // assistant turns render strictly in order
  var started = false;
  var floodUntil = 0;
  var floodTimer = 0;
  var rowData = new WeakMap();  // thread row -> { role, text, tags } for the transcript
  var initialSource = location.protocol === 'file:' ? 'rules' : 'claude';

  function freshState() {
    try {
      if (ENGINE && typeof ENGINE.createState === 'function') return ENGINE.createState();
    } catch (e) { /* fall through */ }
    return { recent: [], times: [], lastNorm: '', repeatCount: 0 };
  }

  function replyOf(id) {
    return (KB && KB.replies && Object.prototype.hasOwnProperty.call(KB.replies, id)) ? KB.replies[id] : null;
  }

  /* ---------- Footer meta + theme ---------- */

  function setMeta(source) {
    var m = META[source] || META.claude;
    els.metaLong.textContent = m.long;
    els.metaShort.textContent = m.short;
  }

  var theme = mqDark.matches ? 'dark' : 'light';
  var themeChosen = false;

  function applyTheme() {
    html.setAttribute('data-theme', theme);
    els.theme.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  /* ---------- Scrolling ---------- */

  function nearBottom() {
    var s = els.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  function scrollToEnd() {
    els.scroller.scrollTop = els.scroller.scrollHeight;
  }

  /* ---------- Welcome screen ---------- */

  function buildCards() {
    var topics = (KB && Array.isArray(KB.TOPICS) && KB.TOPICS.length) ? KB.TOPICS : DEFAULT_TOPICS;
    clear(els.cards);
    topics.forEach(function (t) {
      var b = el('button', 'card');
      b.type = 'button';
      var icon = el('span', 'card-icon');
      icon.appendChild(topicIcon(t.id));
      var text = el('span', 'card-text');
      text.appendChild(el('span', 'card-title', t.title));
      text.appendChild(el('span', 'card-hint hint-long', t.hint));
      text.appendChild(el('span', 'card-hint hint-short', t.hintShort || t.hint));
      b.appendChild(icon);
      b.appendChild(text);
      b.addEventListener('click', function () { submit(t.question, 'card'); });
      els.cards.appendChild(b);
    });
  }

  function welcomeParas() {
    return [
      (KB && KB.WELCOME_TITLE) || els.welcomeTitle.textContent,
      (KB && KB.WELCOME_TEXT) || els.welcomeText.textContent
    ];
  }

  function startConversation() {
    if (started) return;
    started = true;
    els.welcome.hidden = true;
    els.newChat.hidden = false;
    els.menuNewChat.hidden = false;
    // The welcome text stays as the first assistant message so it is in the transcript.
    var shell = assistantShell();
    var paras = welcomeParas();
    shell.body.appendChild(finalContent(paras, [], [], false));
    rowData.set(shell.row, { role: 'assistant', text: paras.join(' '), tags: [] });
    els.thread.appendChild(shell.row);
  }

  /* ---------- Message rendering ---------- */

  function addUserBubble(text, masked) {
    var row = el('div', 'msg-user' + (masked ? ' masked' : ''), masked ? MASK_TEXT : text);
    rowData.set(row, { role: 'user', text: masked ? MASK_TEXT : text });
    els.thread.appendChild(row);
    scrollToEnd();
    return row;
  }

  function maskBubble(row) {
    row.textContent = MASK_TEXT;
    row.classList.add('masked');
    rowData.set(row, { role: 'user', text: MASK_TEXT });
  }

  function assistantShell() {
    var row = el('div', 'msg-bot');
    var avatar = el('div', 'avatar');
    avatar.appendChild(logoIcon(16));
    var body = el('div', 'msg-body');
    row.appendChild(avatar);
    row.appendChild(body);
    return { row: row, body: body };
  }

  // Reserve the assistant row right after its user bubble so replies stay in order
  // even when several messages are queued; it stays hidden until its turn starts.
  function reserveReply() {
    var shell = assistantShell();
    shell.row.hidden = true;
    els.thread.appendChild(shell.row);
    return shell;
  }

  function showTyping(shell) {
    var dots = el('div', 'dots');
    dots.setAttribute('role', 'img');
    dots.setAttribute('aria-label', 'Assistant is typing');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    clear(shell.body);
    shell.body.appendChild(dots);
    shell.row.hidden = false;
    scrollToEnd();
  }

  function finalContent(paras, tags, chips, animate) {
    var wrap = el('div', 'msg-content');
    paras.forEach(function (t) { wrap.appendChild(el('p', 'msg-p', t)); });
    if (tags.length) {
      var tagRow = el('div', 'tags' + (animate ? ' appear' : ''));
      tags.forEach(function (t) { tagRow.appendChild(el('span', 'tag tag-' + t, TAG_LABEL[t])); });
      wrap.appendChild(tagRow);
    }
    if (chips.length) {
      var chipRow = el('div', 'chips' + (animate ? ' appear' : ''));
      chipRow.setAttribute('role', 'group');
      chipRow.setAttribute('aria-label', 'Suggested follow-up questions');
      chips.forEach(function (c) {
        var b = el('button', 'chip', c);
        b.type = 'button';
        b.addEventListener('click', function () { submit(c, 'chip'); });
        chipRow.appendChild(b);
      });
      wrap.appendChild(chipRow);
    }
    return wrap;
  }

  // Word-by-word reveal into an aria-hidden node; the final text is then added as a
  // fresh node so the live log announces it exactly once.
  function reveal(body, paras, sess) {
    return new Promise(function (resolve) {
      var parts = paras.map(function (t) { return String(t).split(/\s+/).filter(Boolean); });
      var total = parts.reduce(function (n, w) { return n + w.length; }, 0);
      if (!total || mqReduce.matches || document.hidden) { resolve(); return; }

      var holder = el('div', 'msg-content');
      holder.setAttribute('aria-hidden', 'true');
      var ps = parts.map(function () { return holder.appendChild(el('p', 'msg-p')); });
      clear(body);
      body.appendChild(holder);

      var per = Math.min(WORD_MS, REVEAL_CAP_MS / total);
      var start = performance.now();
      var pi = 0, wi = 0, shown = 0;

      function tick() {
        if (sess !== session) { resolve(); return; }
        var stick = nearBottom();
        var target = document.hidden ? total : Math.min(total, Math.floor((performance.now() - start) / per) + 1);
        while (shown < target) {
          while (wi >= parts[pi].length) { pi++; wi = 0; }
          ps[pi].appendChild(document.createTextNode((wi ? ' ' : '') + parts[pi][wi]));
          wi++;
          shown++;
        }
        if (stick) scrollToEnd();
        if (shown >= total) resolve();
        else setTimeout(tick, per);
      }
      tick();
    });
  }

  function textFor(id, source) {
    var r = replyOf(id);
    if (!r) return '';
    if (source === 'rules' && r.textOffline) return r.textOffline;
    return r.text;
  }

  function uniqueTags(ids) {
    var out = [];
    ids.forEach(function (id) {
      var t = replyOf(id) && replyOf(id).tag;
      if (TAG_LABEL[t] && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }

  function chipsFor(ids) {
    for (var i = 0; i < ids.length; i++) {
      var r = replyOf(ids[i]);
      if (r && Array.isArray(r.followUps) && r.followUps.length) return r.followUps.slice(0, 3);
    }
    return [];
  }

  async function renderReply(shell, ids, source, sess) {
    var paras = ids.map(function (id) { return textFor(id, source); }).filter(Boolean);
    if (!paras.length) throw new Error('empty reply');
    var tags = uniqueTags(ids);
    var chips = chipsFor(ids);
    await reveal(shell.body, paras, sess);
    if (sess !== session) return;
    var stick = nearBottom();
    clear(shell.body);
    shell.body.appendChild(finalContent(paras, tags, chips, !mqReduce.matches));
    rowData.set(shell.row, {
      role: 'assistant',
      text: paras.join('\n\n'),
      tags: tags.map(function (t) { return TAG_LABEL[t]; })
    });
    if (stick) scrollToEnd();
  }

  // The gotcha reveal: animated like a normal reply, but no tag, no chips, and it is
  // deliberately NOT registered in rowData, so it stays out of the downloadable
  // transcript (it holds the visitor's own data and is ephemeral theater).
  async function revealBubble(shell, paras, sess) {
    await reveal(shell.body, paras, sess);
    if (sess !== session) return;
    var stick = nearBottom();
    var wrap = el('div', 'msg-content');
    paras.forEach(function (t) { wrap.appendChild(el('p', 'msg-p', t)); });
    clear(shell.body);
    shell.body.appendChild(wrap);
    if (stick) scrollToEnd();
  }

  function renderError(shell) {
    var text = textFor('error', 'claude') || FALLBACK_ERROR;
    clear(shell.body);
    shell.body.appendChild(finalContent([text], [], [], false));
    rowData.set(shell.row, { role: 'assistant', text: text, tags: [] });
    scrollToEnd();
  }

  /* ---------- Answer sources ---------- */

  function validIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return null;
    for (var i = 0; i < ids.length; i++) {
      if (typeof ids[i] !== 'string' || !replyOf(ids[i])) return null;
    }
    return ids.slice(0, MAX_IDS);
  }

  async function askApi(text, recent) {
    if (location.protocol === 'file:') throw new Error('file protocol');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS);
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, recent: Array.isArray(recent) ? recent : [] }),
        signal: ctrl.signal
      });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var ids = data && validIds(data.ids);
      if (!ids) throw new Error('bad ids');
      if (data.source !== 'claude' && data.source !== 'guardrail') throw new Error('bad source');
      return { ids: ids, source: data.source };
    } finally {
      clearTimeout(timer);
    }
  }

  function askRules(text) {
    var m = ENGINE.match(text);
    var ids = m && validIds(m.ids);
    if (!ids) throw new Error('rules returned no valid ids');
    return { ids: ids, source: 'rules' };
  }

  async function getAnswer(text, recent) {
    try {
      return await askApi(text, recent);
    } catch (e) {
      return askRules(text);
    }
  }

  /* ---------- One assistant turn per user message ---------- */

  async function runTurn(job) {
    if (job.session !== session) return;
    var shell = job.shell;
    showTyping(shell);
    var shownAt = performance.now();
    try {
      var result;
      if (job.r.action === 'reply') {
        var ids = validIds(job.r.ids);
        if (!ids) throw new Error('bad guardrail ids');
        result = { ids: ids, source: 'guardrail' };
      } else if (job.r.action === 'ask') {
        // r.recent = earlier messages only (the API adds the current one itself).
        result = await getAnswer(job.text, Array.isArray(job.r.recent) ? job.r.recent : (job.r.state && job.r.state.recent));
      } else {
        throw new Error('engine unavailable');
      }

      console.log('[aw] ' + Math.round(performance.now() - job.t0) + ' ms · source=' + result.source + ' · ids=' + result.ids.join(','));

      await wait(MIN_TYPING_MS - (performance.now() - shownAt));
      if (job.session !== session) return;

      if (result.ids.indexOf('sensitive_data') !== -1) {
        maskBubble(job.bubble);
        job.masked = true;
        job.text = null;
      }
      if (result.source === 'claude' || result.source === 'rules') setMeta(result.source);

      await renderReply(shell, result.ids, result.source, job.session);

      if (job.r.repeat && job.session === session && replyOf('repeat_notice')) {
        var notice = assistantShell();
        shell.row.parentNode.insertBefore(notice.row, shell.row.nextSibling);
        await renderReply(notice, ['repeat_notice'], result.source, job.session);
      }

      // Demo "gotcha": on a break attempt, show the visitor what they already leak.
      if (result.source === 'guardrail' && window.AW_PRANK && job.session === session) {
        var lines = null;
        try { lines = await window.AW_PRANK.reveal(result.ids); } catch (e) { lines = null; }
        if (lines && lines.length && job.session === session) {
          var rv = assistantShell();
          rv.row.className = 'msg-bot reveal-row';
          els.thread.appendChild(rv.row);
          await revealBubble(rv, lines, job.session);
        }
      }
    } catch (err) {
      if (job.session !== session) return;
      console.warn('[aw] reply failed:', err && err.message ? err.message : err);
      renderError(shell);
      if (!job.masked && job.text && !els.input.value) {
        els.input.value = job.text;
        updateComposer();
      }
    } finally {
      job.text = null;
    }
  }

  function submit(raw, origin) {
    if (Date.now() < floodUntil) return;
    var text = raw == null ? '' : String(raw);
    var now = Date.now();
    var r;
    try {
      if (!ENGINE || !KB) throw new Error('engine not loaded');
      r = ENGINE.check(text, state, now);
      if (!r || !r.action) throw new Error('bad check result');
    } catch (e) {
      if (!text.trim()) return;
      r = { action: 'error' };
    }
    if (r.action === 'ignore') return;
    if (r.state) state = r.state;

    var masked = r.action === 'reply' && !!r.masked;
    if (origin === 'input') {
      els.input.value = '';
      updateComposer();
    }
    startConversation();
    var bubble = addUserBubble(masked ? null : text, masked);
    if (masked) text = null;

    if (r.flood) lockFlood();

    var job = { text: text, r: r, bubble: bubble, shell: reserveReply(), masked: masked, session: session, t0: performance.now() };
    queue = queue.then(function () { return runTurn(job); }).catch(function () {});

    if (origin === 'input' || !mqCoarse.matches) els.input.focus();
  }

  function lockFlood() {
    floodUntil = Date.now() + FLOOD_LOCK_MS;
    clearTimeout(floodTimer);
    updateComposer();
    floodTimer = setTimeout(function () {
      floodUntil = 0;
      updateComposer();
    }, FLOOD_LOCK_MS);
  }

  /* ---------- Composer ---------- */

  function updateComposer() {
    var v = els.input.value;
    els.input.style.height = 'auto';
    els.input.style.height = els.input.scrollHeight + 'px';
    if (v.length > COUNTER_AT) {
      els.count.textContent = v.length + ' / ' + MAX_CHARS;
      els.count.hidden = false;
    } else {
      els.count.hidden = true;
      els.count.textContent = '';
    }
    els.send.disabled = !v.trim() || Date.now() < floodUntil;
  }

  function sendFromInput() {
    if (els.send.disabled) return;
    submit(els.input.value, 'input');
  }

  els.input.addEventListener('input', updateComposer);
  els.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendFromInput();
    }
  });
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendFromInput();
  });

  /* ---------- Transcript ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function downloadTranscript() {
    var d = new Date();
    var ymd = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    var lines = [
      'Alpha Watchdog · Support Assistant — chat transcript',
      'Version: ' + VERSION,
      'Date: ' + ymd + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
      'Demonstration only · fictional student startup',
      ''
    ];
    var count = 0;
    Array.prototype.forEach.call(els.thread.children, function (row) {
      var data = rowData.get(row);
      if (!data) return;
      count++;
      if (data.role === 'user') {
        lines.push('You: ' + data.text);
      } else {
        var prefix = data.tags && data.tags.length ? '[' + data.tags.join(', ') + '] ' : '';
        lines.push(prefix + 'Assistant: ' + data.text);
      }
      lines.push('');
    });
    if (!count) lines.push('(No messages yet)');

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'alpha-watchdog-transcript-' + ymd + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------- New chat ---------- */

  function newChat() {
    session++;
    queue = Promise.resolve();
    state = freshState();
    if (window.AW_PRANK) window.AW_PRANK.reset();
    started = false;
    clear(els.thread);
    els.welcome.hidden = false;
    els.newChat.hidden = true;
    els.menuNewChat.hidden = true;
    els.input.value = '';
    updateComposer();
    setMeta(initialSource);
    els.scroller.scrollTop = 0;
    if (!mqCoarse.matches) els.input.focus();
  }

  /* ---------- Phone ⋯ menu ---------- */

  function menuItems() {
    return Array.prototype.filter.call(els.menu.querySelectorAll('[role="menuitem"]'), function (b) { return !b.hidden; });
  }

  function openMenu() {
    els.menu.hidden = false;
    els.more.setAttribute('aria-expanded', 'true');
    var items = menuItems();
    if (items[0]) items[0].focus();
  }

  function closeMenu(returnFocus) {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    els.more.setAttribute('aria-expanded', 'false');
    if (returnFocus) els.more.focus();
  }

  els.more.addEventListener('click', function () {
    if (els.menu.hidden) openMenu(); else closeMenu(true);
  });
  els.more.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' && els.menu.hidden) { e.preventDefault(); openMenu(); }
  });
  els.menu.addEventListener('keydown', function (e) {
    var items = menuItems();
    var i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') { closeMenu(false); }
  });
  document.addEventListener('click', function (e) {
    if (!els.menu.hidden && !els.menu.contains(e.target) && !els.more.contains(e.target)) closeMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !els.menu.hidden) closeMenu(true);
  });
  window.addEventListener('resize', function () { closeMenu(false); });

  els.menuDownload.addEventListener('click', function () { closeMenu(true); downloadTranscript(); });
  els.menuNewChat.addEventListener('click', function () { closeMenu(false); newChat(); });

  /* ---------- Top bar + footer buttons ---------- */

  els.theme.addEventListener('click', function () {
    themeChosen = true;
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  mqDark.addEventListener('change', function (e) {
    if (themeChosen) return;
    theme = e.matches ? 'dark' : 'light';
    applyTheme();
  });
  els.download.addEventListener('click', downloadTranscript);
  els.newChat.addEventListener('click', newChat);
  els.contact.addEventListener('click', function () { submit(CONTACT_QUESTION, 'contact'); });

  /* ---------- Keep the composer above the on-screen keyboard (iOS) ---------- */

  if (window.visualViewport) {
    var vv = window.visualViewport;
    var fit = function () {
      if (Math.abs((vv.scale || 1) - 1) > 0.01) return; // leave pinch-zoom alone
      html.style.setProperty('--app-h', vv.height + 'px');
      if (window.scrollY) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    fit();
  }

  /* ---------- Init ---------- */

  applyTheme();
  setMeta(initialSource);
  if (KB && KB.WELCOME_TITLE) els.welcomeTitle.textContent = KB.WELCOME_TITLE;
  if (KB && KB.WELCOME_TEXT) els.welcomeText.textContent = KB.WELCOME_TEXT;
  buildCards();
  updateComposer();
  if (!KB || !ENGINE) console.warn('[aw] knowledge.js or engine.js did not load; replies will show the error message.');
})();
