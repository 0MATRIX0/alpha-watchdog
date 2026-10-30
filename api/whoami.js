'use strict';
// GET /api/whoami -> { ip }
// Reflects back the caller's OWN public IP: the single identifier every web server
// receives on every request. Used only by the "gotcha" reveal (prank.js) to show a
// visitor what they already expose. Nothing is stored and nothing is logged.
// Same-origin only; returns nothing else about the request.

function sameOrigin(req) {
  var origin = req.headers.origin;
  if (!origin) return true;
  try {
    var host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.end('{"error":"method"}'); return; }
  if (!sameOrigin(req)) { res.statusCode = 403; res.end('{"error":"origin"}'); return; }
  var fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  var ip = fwd || (req.socket && req.socket.remoteAddress) || '';
  // IPv6-mapped IPv4 -> plain IPv4 for readability.
  ip = ip.replace(/^::ffff:/, '');
  res.statusCode = 200;
  res.end(JSON.stringify({ ip: ip }));
};
