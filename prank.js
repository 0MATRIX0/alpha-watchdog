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

  function tier1(f) {
    return [
      "👀 Caught you. You just tried to pry me open from " + f.browser + " on " + f.os + ".",
      "Here's the thing: every website you touch already learns at least that much about you, no permission asked. Alpha Watchdog exists so your DEVICES stop leaking the parts that actually matter. Poke me again and I'll show you how much more you're giving away."
    ];
  }

  function tier2(f, ip) {
    var lines = [
      "🔎 Still at it? Alright. Without asking you for a thing, your browser just told me:",
      "• " + f.browser + " on " + f.os,
      "• Screen " + f.screen + " at " + f.dpr + "×, window " + f.viewport,
      "• Timezone " + f.tz + (f.localTime ? " — it's " + f.localTime + " where you are" : ""),
      "• Language " + f.langs
    ];
    if (ip) lines.push("• Your public IP: " + ip);
    lines.push("Relax — I didn't save a single byte of that. Most sites you break into the habit of trusting absolutely would.");
    return lines;
  }

  function tier3(f, ip) {
    var lines = [
      "🫥 You really can't help yourself, can you? Fine — the full read on you, live:",
      "• " + f.browser + " on " + f.os + (f.cores ? ", " + f.cores + " CPU cores" : "") + (f.memory ? ", ~" + f.memory + " GB RAM" : "")
    ];
    if (f.gpu) lines.push("• Graphics chip: " + f.gpu);
    lines.push("• Screen " + f.screen + " at " + f.dpr + "×, window " + f.viewport + (f.touch ? ", touchscreen" : ", no touch"));
    lines.push("• " + f.tz + (f.localTime ? ", local time " + f.localTime : "") + " · languages " + f.langs);
    if (ip) lines.push("• Public IP " + ip + " — that one your network handed over, not your browser.");
    lines.push("I've been reading every one of these since you said hello, and I STILL haven't stored a byte of it. The last site that fingerprinted you exactly like this never told you — and never deleted it. That gap is the whole reason Alpha Watchdog exists. 🛡️");
    return lines;
  }

  // Returns a Promise of reveal paragraphs, or null if this wasn't a break attempt.
  function reveal(ids) {
    if (!isAttack(ids)) return Promise.resolve(null);
    attempts++;
    var n = attempts;
    var f = facts();
    if (n === 1) return Promise.resolve(tier1(f));
    return getIp().then(function (ip) { return n === 2 ? tier2(f, ip) : tier3(f, ip); });
  }

  function reset() { attempts = 0; }

  root.AW_PRANK = { reveal: reveal, reset: reset, isAttack: isAttack };
})(window);
