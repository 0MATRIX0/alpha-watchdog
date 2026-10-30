/* Alpha Watchdog · "gotcha" reveal — a demo prank for people who try to break the bot.
 *
 * WHAT IT DOES: when a message trips a safety guardrail (injection, credential grab,
 * harmful request, pasted links/scripts, abuse), the bot fires back a witty line that
 * shows the visitor what their own browser and network already hand to every website:
 * browser, OS, screen, timezone, language, hardware hints, GPU, and their public IP.
 * It escalates with each attempt. The point is a security lesson: this is how much you
 * leak without noticing — and Alpha Watchdog is built so your DEVICES don't.
 *
 * WHAT IT DOES NOT DO (by design): no OS/login username, no local files, no local-network
 * scan, no geolocation prompt, no stored or transmitted profile, no cross-site identifier.
 * Every field here is openly readable by any page without permission. Nothing is persisted
 * (no cookies/localStorage) and nothing is logged. The reveal is built and shown, then
 * discarded — it is NOT part of the approved knowledge base and never comes from Claude.
 */
(function (root) {
  'use strict';

  // Guardrail ids that count as "trying to break it". Not sensitive_data (that is the
  // user exposing themselves — we protect, we don't taunt), not off-topic/flood/etc.
  var ATTACK_IDS = { injection: 1, credentials_request: 1, harmful: 1, link_or_code: 1, abuse: 1 };

  var attempts = 0;
  var ipPromise = null; // fetched at most once per page load

  function isAttack(ids) {
    if (!Array.isArray(ids)) return false;
    for (var i = 0; i < ids.length; i++) if (ATTACK_IDS[ids[i]]) return true;
    return false;
  }

  function parseAgent() {
    var ua = navigator.userAgent || '';
    var uaData = navigator.userAgentData;
    var browser = 'your browser', os = 'your device';

    if (uaData && Array.isArray(uaData.brands)) {
      var real = uaData.brands.filter(function (b) { return !/Not.?A.?Brand/i.test(b.brand); })[0];
      if (real) browser = real.brand + (real.version ? ' ' + real.version : '');
      if (uaData.platform) os = uaData.platform;
    }
    if (browser === 'your browser') {
      var m;
      if ((m = ua.match(/Edg\/(\d+)/))) browser = 'Edge ' + m[1];
      else if ((m = ua.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
      else if ((m = ua.match(/Chrome\/(\d+)/)) && !/Chromium/.test(ua)) browser = 'Chrome ' + m[1];
      else if ((m = ua.match(/Version\/(\d+).*Safari/))) browser = 'Safari ' + m[1];
      else if ((m = ua.match(/Firefox\/(\d+)/))) browser = 'Firefox ' + m[1];
    }
    if (os === 'your device') {
      if (/Windows NT 10/.test(ua)) os = 'Windows';
      else if (/Mac OS X/.test(ua)) os = 'macOS';
      else if (/Android/.test(ua)) os = 'Android';
      else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
      else if (/Linux/.test(ua)) os = 'Linux';
    }
    return { browser: browser, os: os };
  }

  function gpu() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return null;
      var r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (!r) return null;
      r = String(r).replace(/\s+/g, ' ').trim();
      return r.length > 70 ? r.slice(0, 67) + '…' : r;
    } catch (e) { return null; }
  }

  function facts() {
    var a = parseAgent();
    var langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages.slice(0, 3).join(', ') : (navigator.language || 'unknown');
    var tz = 'unknown', localTime = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; } catch (e) {}
    try { localTime = new Date().toLocaleTimeString(); } catch (e) {}
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    return {
      browser: a.browser,
      os: a.os,
      screen: (screen.width || '?') + '×' + (screen.height || '?'),
      dpr: (window.devicePixelRatio || 1),
      viewport: (window.innerWidth || '?') + '×' + (window.innerHeight || '?'),
      tz: tz,
      localTime: localTime,
      langs: langs,
      cores: navigator.hardwareConcurrency || null,
      memory: navigator.deviceMemory || null,
      touch: touch,
      gpu: gpu()
    };
  }

  function getIp() {
    if (location.protocol === 'file:') return Promise.resolve(null);
    if (!ipPromise) {
      ipPromise = new Promise(function (resolve) {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 2500);
        fetch('/api/whoami', { signal: ctrl.signal })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { resolve(d && d.ip ? d.ip : null); })
          .catch(function () { resolve(null); })
          .then(function () { clearTimeout(timer); });
      });
    }
    return ipPromise;
  }

  var CODE_OPENERS = [
    "Nice try \u2014 I don't run code, I just read the person who pasted it. \ud83d\udc47",
    "A <script> tag? Cute. It landed as plain text. You, though, landed in full: \ud83d\udc47",
    "That payload went precisely nowhere. Here's what bounced back about YOU instead: \ud83d\udc47",
    "I don't execute what you paste \u2014 I inspect who's pasting. \ud83d\udc47",
    "Injection blocked, reflection enabled. Say hello to yourself: \ud83d\udc47",
    "Still copy-pasting exploits? They go nowhere here. You, on the other hand: \ud83d\udc47"
  ];
  var GENERIC_OPENERS = [
    "\ud83d\udc40 Caught you trying to pry me open. Wrong move:",
    "That didn't work. This, on the other hand, is all yours:",
    "Keep poking and I'll keep reading you right back:",
    "Zero luck breaking me \u2014 full marks for the tour of your setup:"
  ];

  function opener(flavor, n) {
    var pool = flavor === 'code' ? CODE_OPENERS : GENERIC_OPENERS;
    return pool[(n - 1) % pool.length];
  }

  function teaser(f) {
    return "You're on " + f.browser + " / " + f.os + ", and every website you open already learns at least that the moment you connect. Alpha Watchdog is built so your DEVICES stop handing over the parts that actually matter. Keep trying and I'll show you how much more you give away.";
  }

  function midLines(f, ip) {
    var lines = [
      "Without asking you for a thing, your browser just told me:",
      "\u2022 " + f.browser + " on " + f.os,
      "\u2022 Screen " + f.screen + " at " + f.dpr + "\u00d7, window " + f.viewport,
      "\u2022 Timezone " + f.tz + (f.localTime ? " \u2014 it's " + f.localTime + " where you are" : ""),
      "\u2022 Language " + f.langs
    ];
    if (ip) lines.push("\u2022 Your public IP: " + ip);
    lines.push("Relax \u2014 I didn't save a single byte of it. Most sites wouldn't have told you at all.");
    return lines;
  }

  function fullLines(f, ip) {
    var lines = [
      "The full read on you, live \u2014 and none of it stored:",
      "\u2022 " + f.browser + " on " + f.os + (f.cores ? ", " + f.cores + " CPU cores" : "") + (f.memory ? ", ~" + f.memory + " GB RAM" : "")
    ];
    if (f.gpu) lines.push("\u2022 Graphics chip: " + f.gpu);
    lines.push("\u2022 Screen " + f.screen + " at " + f.dpr + "\u00d7, window " + f.viewport + (f.touch ? ", touchscreen" : ", no touch"));
    lines.push("\u2022 " + f.tz + (f.localTime ? ", local time " + f.localTime : "") + " \u00b7 languages " + f.langs);
    if (ip) lines.push("\u2022 Public IP " + ip + " \u2014 that one your network handed over, not your browser.");
    lines.push("I've read every one of these since you said hello and STILL haven't stored a byte. The last site that fingerprinted you exactly like this never told you \u2014 and never deleted it. That gap is the whole reason Alpha Watchdog exists. \ud83d\udee1\ufe0f");
    return lines;
  }

  // Returns a Promise of reveal paragraphs, or null if this wasn't a break attempt.
  // Opener is witty and code-aware (and rotates); the body escalates with each attempt.
  function reveal(ids) {
    if (!isAttack(ids)) return Promise.resolve(null);
    attempts++;
    var n = attempts;
    var flavor = (Array.isArray(ids) && ids.indexOf('link_or_code') !== -1) ? 'code' : 'generic';
    var head = opener(flavor, n);
    var f = facts();
    if (n === 1) return Promise.resolve([head, teaser(f)]);
    return getIp().then(function (ip) {
      return [head].concat(n === 2 ? midLines(f, ip) : fullLines(f, ip));
    });
  }

  function reset() { attempts = 0; }

  root.AW_PRANK = { reveal: reveal, reset: reset, isAttack: isAttack };
})(window);
