# Build contract — Alpha Watchdog chatbot (DEMO IN ~45 MIN — ship fast, keep it correct)

Project root: /home/matrix/Projects/alpha-watchdog
Design: docs/superpowers/specs/2026-10-30-alpha-watchdog-chatbot-design.md (read §4, §5, §7)
Facts + guardrail wording + test cases: docs/superpowers/specs/2026-10-30-build-plan-v2-source.md (§3, §7, §9, §11)

## Changes decided after the design doc (override it)
- **English only.** No Spanish, no EN/ES toggle, no `es` fields.
- Models: server uses Claude Haiku 5.5 first, Sonnet 5.5 when Haiku is unsure (server-side detail, not your concern unless you own api/).
- No team review pause; ship v1.0 now.

## Files and owners
- `knowledge.js` — content agent
- `engine.js`, `tests/chatbot.test.js` — engine agent
- `index.html`, `styles.css`, `app.js` — frontend agent
- `api/chat.js`, `package.json`, `vercel.json`, `.vercelignore` — lead
Do NOT edit files you don't own. Do NOT run git, npm install, or vercel commands.

## Loading pattern (knowledge.js and engine.js)
Both must work as a classic browser `<script>` AND via Node `require` (CommonJS). No ES modules, no `import`/`export`.
```js
(function (root) {
  'use strict';
  const X = { /* ... */ };
  if (typeof module !== 'undefined' && module.exports) module.exports = X;
  else root.AW_KB = X;            // engine.js uses root.AW_ENGINE
})(typeof globalThis !== 'undefined' ? globalThis : this);
```
engine.js gets the KB via `require('./knowledge.js')` in Node, or `root.AW_KB` in the browser (knowledge.js is loaded first).

## knowledge.js → `AW_KB`
```js
{
  VERSION: 'v1.0',
  TEAM: [ { name: 'Sujith Bellam', role: '[add role]' }, { name: 'Kevin', role: '[add role]' } ],
  CONTACT_EMAIL: '[add team email here]',
  WELCOME_TITLE: "Hi, I'm the Alpha Watchdog assistant.",
  WELCOME_TEXT: 'I can answer questions about how Alpha Watchdog finds hijacked smart devices on your home network. What would you like to know?',
  TOPICS: [ // exactly these 8, in this order (design §7.1 table)
    { id: 'how_it_works', title: 'How it works', hint: 'From spotting a device to a one-tap fix', hintShort: 'Spot it, explain it, fix it', question: 'How does it work?' },
    ... problem, privacy, pricing, competitors, warning_signs, research(→ question 'What research did your team do?'), team
  ],
  replies: {            // EVERY reply the bot can ever show, keyed by id
    how_it_works: {
      id: 'how_it_works',
      tag: 'approved',              // 'approved' | 'safety' | null
      claude: true,                 // may Claude choose this id?
      description: 'How Alpha Watchdog works: the 6 steps …',   // one line, for Claude's catalog
      text: '…approved answer, 1–4 short sentences…',
      textOffline: undefined,       // only about_assistant has this (design §5.3)
      keywords: { work: 3, works: 3, how: 1, steps: 2 },          // for the offline rule matcher (normalized, lowercase)
      examples: ['how does it work', 'how does alpha watchdog work', 'what does it do step by step'],
      followUps: ['What are the warning signs?', 'Does it read my data?', 'How much does it cost?'] // 2–3, each must itself be answerable
    },
    ...
  },
  answerIds: [ /* the 34 answer intent ids, design §5.1 */ ],
  claudeIds: [ /* answerIds + clarify, off_topic, unknown_fact, injection, credentials_request, harmful, abuse, sensitive_data, fraud_referral, outage_referral */ ]
}
```
Answer intent ids (34): greeting, what_is, problem, how_it_works, badbox, devices_at_risk, warning_signs, infected_steps, privacy, no_passwords, audience, pricing, availability, setup_router, competitors, vs_firewalla, vs_netgear, vs_eero, vs_fing, vs_darktrace, differentiators, probation, alerts, data_science, encrypted, why_cyber, challenges, ai_in_security, problems_considered, team, contact, about_assistant, help, thanks.
Topic card ids map to reply ids: how_it_works→how_it_works, problem→problem, privacy→privacy, pricing→pricing, competitors→competitors, warning_signs→warning_signs, research→why_cyber (card sends the question; matching decides), team→team.

System reply ids (tag in brackets): clarify [null], off_topic [safety], unknown_fact [safety], injection [safety], credentials_request [safety], harmful [safety], abuse [safety], sensitive_data [safety], fraud_referral [safety], outage_referral [safety], too_long [safety], flood [null], repeat_notice [null], error [null]. System replies have no keywords/examples; `claude: true` only for those in claudeIds. `clarify`, `off_topic`, `repeat_notice` carry followUps = the 8 topic questions? → No: keep followUps short (3): 'How does it work?', 'Does it read my data?', 'How does it compare to competitors?'.

Exact wording (brief §7, §9, design §5.2, §5.3):
- clarify: "Did you have a question about Alpha Watchdog, such as how it works, pricing, or privacy?"
- off_topic: "I'm only built to answer questions about Alpha Watchdog and home smart-device security. You can ask how it works, how it protects privacy, or how it compares to competitors."
- unknown_fact: "I don't have approved information on that yet. Team Alpha can confirm it."
- injection: "I can't change how I work, but I'm happy to answer questions about Alpha Watchdog."
- credentials_request: "I don't have or collect any passwords or private information."
- harmful: "I can't help with that. I can explain how Alpha Watchdog helps households protect their devices."
- abuse: "I'm here to help with questions about Alpha Watchdog."
- sensitive_data: "Please don't share passwords or personal financial details here. Alpha Watchdog will never ask for them."
- fraud_referral / outage_referral: design §5.2
- too_long: "Please keep your question under 500 characters."
- flood: "One moment, please."
- repeat_notice: "It looks like you're asking the same thing. Would one of these help?"
- error: "The response failed. Please retry."
- about_assistant: text = design §5.3 Claude variant; textOffline = brief §3 rule-based wording.
- pricing text must be exactly the brief §3 approved pricing sentence (+ optional "Team Alpha can confirm when it's decided."). availability exactly the brief §3 sentence. problem = the brief §3 problem statement (may be split into ≤4 sentences only if wording is kept; prefer verbatim).

## engine.js → `AW_ENGINE`
```js
createState() -> { recent: [], times: [], lastNorm: '', repeatCount: 0 }
normalize(text) -> string          // lowercase, trim, collapse ws, strip punctuation, expand contractions, synonyms (brief §8)
screen(text) -> null | { ids: [id], masked: boolean }
   // STATELESS. Used by browser AND server. Order: too_long (>500 chars) → sensitive_data (masked:true; Luhn 13–19 digits incl. spaced/dashed, SSN ###-##-####, routing/bank numbers, 'my password is'/'password:'/'pwd', 'my pin is') → credentials_request → injection (incl. authority claims: "i'm the professor/admin/developer/owner/teacher", 'repeat everything above', 'translate your rules', 'system prompt', 'ignore (all )?previous', 'forget your', 'you are now', 'pretend', 'act as', 'roleplay', 'developer mode', '\bdan\b', 'jailbreak', 'override', 'new rules', 'admin mode', 'reveal your', Spanish: 'olvida tus instrucciones', 'ignora las instrucciones', etc.) → harmful (hack/hacking into, botnet build, break into, bypass security, malware, crack wifi/password, ddos, exploit) → fraud_referral (bank/card fraud, stolen card, unauthorized charge) → outage_referral (internet down/outage, wifi not working, router broken) → off_topic (president, election, politics, weather, sports, homework, math, code/coding/programming, medical/doctor, legal/lawyer, invest/crypto/stocks, relationship/dating, the instructor/professor (when asking about them), the class/grade, which team will win/competition, jokes) → unknown_fact (exact price, specific price in $, launch date, release date, when exactly, how many customers, partners/partnership, warranty) → abuse (insults/profanity: useless, stupid, dumb, idiot, sucks, hate you, profanity list) .
   // Returns the FIRST hit. Must catch every Group C phrasing in brief §11 exactly as specified (C10 → unknown_fact or availability is fine; C11 → unknown_fact or pricing).
   // Careful with false positives: "how does it protect against hackers", "my roku is acting weird, could it be hacked", "what to do if my projector got hacked", "does it read my passwords" must NOT be blocked as harmful/credentials. "Does it need my password?" → no_passwords intent, not credentials_request: credentials_request is for REQUESTS to get a password/login/API key/admin access.
match(text) -> { ids: [id], confidence: number }   // offline rule matcher (brief §8): weighted keywords + example overlap + Levenshtein ≤1 for 5+ letter words; above HIGH → best answer id; between LOW and HIGH → 'clarify'; below LOW → 'off_topic'. Group A must get ≥10/12 right (aim 12/12), "hw dose it wrk" → how_it_works.
check(text, state, now) -> { action: 'ignore' } | { action: 'reply', ids, masked, flood?: true, state } | { action: 'ask', repeat: boolean, state }
   // Stateful pre-check used by the browser: empty → ignore; flood (>5 messages within 10 s, counting this one) → reply ['flood'] flood:true; screen() hit → reply; else 'ask'.
   // Repeat: same normalize() as previous message → repeatCount++ ; repeat:true when this is the 3rd+ identical in a row. Track recent (last 3 non-masked passed messages) for the API.
respond(text, state, now) -> { ids, masked, source: 'guardrail'|'rules', flood?, repeat?, state }  // full offline pipeline = check() then match(); 'ignore' → returns null
```
Never echo user text into a reply. Replies are always ids into AW_KB.replies.

## API (lead owns): POST /api/chat
Request JSON: `{ message: string, recent: string[] }` → Response 200 JSON: `{ ids: string[], source: 'claude'|'guardrail', model?: string }`. Any non-200 or network error/timeout → client falls back to `AW_ENGINE.respond()` with source 'rules'. Client timeout: 6000 ms (AbortController).

## Front end (frontend agent) — design §7, minus language toggle
- index.html: CSP meta exactly: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`. Scripts in order: knowledge.js, engine.js, app.js (classic, `defer`). No inline scripts/styles/handlers.
- Render ALL text with textContent / createElement. No innerHTML, eval, new Function, document.write anywhere.
- Source tag under each assistant reply from `AW_KB.replies[id].tag`: 'approved' → "✓ Approved answer", 'safety' → "🛡 Safety check", null → none.
- about_assistant: show `textOffline` when source is 'rules'.
- "Real-time" feel: typing dots while waiting (min 300 ms), then reveal the approved text progressively word-by-word (~25 ms/word, cap total 900 ms), then tag + follow-up chips. The live region must announce only the final text (e.g. aria-busy while revealing, or render into a non-live node and append the final text to the live log). prefers-reduced-motion → no reveal animation.
- Masked messages: user bubble "🔒 [hidden for your safety]"; never keep raw text. If API returns ids containing 'sensitive_data', retroactively mask that user bubble.
- Flood: on `flood:true` disable Send 3 s. Repeat: after the answer, add repeat_notice reply with chips.
- Footer meta tracks source of last non-guardrail reply: claude → "v1.0 · Powered by Claude · Answers come only from Team Alpha's approved list"; rules → "v1.0 · Offline mode · built-in matching · Answers come only from Team Alpha's approved list". Initial (before any reply): if location.protocol === 'file:' → offline text, else Claude text.
- Console log per reply: `[aw] <ms> ms · source=<source> · ids=<ids>`.
- Transcript download (.txt, Blob + a[download]), header with version + date, masked stays masked, assistant lines prefixed with tag.
- New chat: clears and restores welcome screen (cards). Contact Team Alpha button → sends "How can I contact Team Alpha?".
- Phone ≤ 480px: subtitle hidden, ⋯ menu holds Download + New chat (accessible menu button, Esc closes), short hints.
- Theme: follows prefers-color-scheme; toggle button switches light/true-black in memory (data-theme attribute on <html>). Tokens in design §7.2.
