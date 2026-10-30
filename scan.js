/* Alpha Watchdog · simulated "scan your network" demo.
 *
 * A scripted, canned demonstration of the product's core promise: find every device,
 * learn its normal behavior, flag the one acting hijacked, explain it in plain English,
 * and offer a one-tap isolate. NONE of this touches a real network — it is theater built
 * from the approved product facts, triggered by a scan command typed into the chat.
 * Scenarios rotate so repeated runs show different situations. */
(function (root) {
  'use strict';

  function norm(t) {
    return String(t == null ? '' : t).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // A scan COMMAND, not a question about scanning ("does it scan my devices?" stays a Q&A).
  function isScan(text) {
    var w = norm(text);
    if (!w) return false;
    if (/\b(does|do|can|could|will|would|is|are|how|what|why|when|which|should)\b/.test(w)) return false;
    if (w === 'scan' || w === 'run a scan' || w === 'demo') return true;
    return /\b(scan my (network|devices|wifi|home)|scan the network|run (a|the) scan|start (a|the) scan|scan now|demo scan|run (a )?demo( scan)?|run the watchdog|watchdog scan|check my (devices|network))\b/.test(w);
  }

  // status: 'ok' | 'new' | 'alert'
  var SCENARIOS = [
    {
      summary: 'Scan complete. 1 device is acting hijacked.',
      devices: [
        { name: 'Living Room TV (Samsung)', status: 'ok', note: 'normal' },
        { name: "Mom's iPhone", status: 'ok', note: 'normal' },
        { name: 'Nest Thermostat', status: 'ok', note: 'normal' },
        { name: "Kids' iPad", status: 'ok', note: 'normal' },
        { name: 'BudgetStream 4K Box', status: 'alert', note: 'uploading to 142 unknown servers while idle' }
      ],
      alert: {
        device: 'BudgetStream 4K Box',
        what: "It's talking to 142 unfamiliar servers at 2–4 AM while nobody is watching it, and uploading far more than it downloads.",
        why: "That's the classic sign of a hijacked device used as a hidden relay — the same BADBOX 2.0 pattern the FBI warned about.",
        fix: 'Isolate it from your main network now, then factory-reset it or return it to the seller.',
        done: '✓ BudgetStream 4K Box moved to a separate, quarantined network. Your other devices are safe, and it can no longer relay traffic. Next: factory-reset it or return it to the seller.'
      }
    },
    {
      summary: 'Scan complete. 1 device contacted a known botnet.',
      devices: [
        { name: 'Front Door Camera', status: 'alert', note: 'contacting a known botnet address' },
        { name: 'Work Laptop', status: 'ok', note: 'normal' },
        { name: 'Living Room TV (LG)', status: 'ok', note: 'normal' },
        { name: 'Echo Dot', status: 'ok', note: 'normal' },
        { name: 'Robot Vacuum', status: 'ok', note: 'normal' }
      ],
      alert: {
        device: 'Front Door Camera',
        what: 'It just connected to an address on a known botnet blocklist and opened a steady outbound stream.',
        why: 'Your camera may be streaming to someone other than you, or being used to relay attacks on others.',
        fix: 'Isolate it, update its firmware, and change the camera account password from a different device.',
        done: '✓ Front Door Camera isolated. The outbound stream is cut off. Next: update its firmware and change the camera password from a different device.'
      }
    },
    {
      summary: 'Scan complete. No hijacked devices found.',
      devices: [
        { name: 'Living Room TV (Sony)', status: 'ok', note: 'normal' },
        { name: "Dad's Pixel", status: 'ok', note: 'normal' },
        { name: 'Ring Doorbell', status: 'ok', note: 'normal' },
        { name: 'Smart Plug (Kitchen)', status: 'ok', note: 'normal' },
        { name: 'New: Echo Dot', status: 'new', note: 'on probation (2 days) — learning its normal behavior' }
      ],
      alert: null,
      allClear: 'No hijacked devices found. 1 new device is on a separate network for its first few days while I learn what normal looks like for it. I’ll keep watching and alert you the moment anything acts up.'
    }
  ];

  var idx = 0;
  function next() { var s = SCENARIOS[idx % SCENARIOS.length]; idx++; return s; }
  function reset() { idx = 0; }

  root.AW_SCAN = { isScan: isScan, next: next, reset: reset };
})(window);
