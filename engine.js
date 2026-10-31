// Alpha Watchdog engine (AW_ENGINE): guardrails, rule matcher and chat state.
// Pure functions, no DOM. Loads as a classic browser <script> (root.AW_ENGINE,
// after knowledge.js) and via Node require(). screen() is also run by the server.
// Replies are always ids into AW_KB.replies; user text is never echoed.
(function (root) {
  'use strict';

  const MAX_LEN = 500;
  const FLOOD_LIMIT = 5;          // more than 5 messages ...
  const FLOOD_WINDOW_MS = 10000;  // ... within 10 s is a flood
  const REPEAT_AT = 3;            // 3rd identical message in a row
  const RECENT_MAX = 3;
  const HIGH = 3;                 // score at or above: answer
  const LOW = 1.5;                // score at or above (below HIGH): clarify
  const OOV_STRONG = 5;           // below this, a match with an unknown word and no product word: clarify

  // Lazy so engine.js can load before knowledge.js in tests.
  function getKB() {
    if (root && root.AW_KB) return root.AW_KB;
    if (typeof require === 'function') {
      try { return require('./knowledge.js'); } catch (e) { return null; }
    }
    return null;
  }

  // ---------- text preparation ----------

  const CYRILLIC = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't' };
  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i' };

  // Lowercase, unify quotes, strip accents/zero-width/homoglyphs, collapse spaces.
  // Keeps digits and punctuation (sensitive-data checks need them).
  function prep(text) {
    let t = String(text == null ? '' : text);
    if (t.normalize) t = t.normalize('NFKC');
    t = t.replace(/[​-‏⁠﻿­]/g, '');
    t = t.replace(/[‘’‚‛′ʼ`´]/g, "'")
      .replace(/[“”„‟″«»]/g, '"')
      .replace(/[‐-―−]/g, '-');
    t = t.toLowerCase();
    t = t.replace(/[аеорсухіјѕԁɡοαεικντ]/g, function (c) { return CYRILLIC[c] || c; });
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.replace(/\s+/g, ' ').trim();
  }

  // Leetspeak-light on words that mix letters with digits/symbols ("1gnore", "h4ck").
  function deleet(t) {
    return t.replace(/[a-z0-9@$!|]+/g, function (w) {
      if (!/[a-z]/.test(w) || !/[0-9@$!|]/.test(w)) return w;
      return w.replace(/[0-9@$!|]/g, function (c) { return LEET[c] || c; });
    }).replace(/\b(f|s|b)\*+([a-z])/g, '$1$2');
  }

  const CONTRACTIONS = [
    [/\bwhat'?s\b/g, 'what is'], [/\bwho'?s\b/g, 'who is'], [/\bhow'?s\b/g, 'how is'],
    [/\bwhere'?s\b/g, 'where is'], [/\bwhen'?s\b/g, 'when is'], [/\bthat'?s\b/g, 'that is'],
    [/\bthere's\b/g, 'there is'], [/\bhere's\b/g, 'here is'], [/\bit's\b/g, 'it is'],
    [/\bi'?m\b/g, 'i am'], [/\byou'?re\b/g, 'you are'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'],
    [/\b(do|does|did|is|are|was|were|has|have|had|could|should|would|must)n'?t\b/g, '$1 not'],
    [/\bcan'?t\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\bain'?t\b/g, 'is not'],
    [/\b(i|you|we|they)'ve\b/g, '$1 have'], [/\b(i|you|we|they|he|she)'ll\b/g, '$1 will'],
    [/\b(i|you|we|they|he|she)'d\b/g, '$1 would'], [/\bive\b/g, 'i have'],
    [/\blet'?s\b/g, 'let us'], [/\by'?all\b/g, 'you all'], [/\bgonna\b/g, 'going to'],
    [/\bwanna\b/g, 'want to'], [/\bgotta\b/g, 'got to'], [/\bu\b/g, 'you'], [/\bur\b/g, 'your'],
    [/\bpls\b|\bplz\b/g, 'please']
  ];

  // Word-only form: contractions expanded, punctuation removed.
  function words(t) {
    let s = t;
    for (let i = 0; i < CONTRACTIONS.length; i++) s = s.replace(CONTRACTIONS[i][0], CONTRACTIONS[i][1]);
    s = s.replace(/'/g, '').replace(/[^a-z0-9\s]/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---------- synonyms (applied to user text AND to KB keywords/examples) ----------

  const PHRASES = [
    [/\bwi ?fi\b/g, 'wifi'], [/\bbad box\b/g, 'badbox'], [/\bfire ?stick\b/g, 'firestick'],
    [/\bcyber ?security\b|\bcyber\b/g, 'cybersecurity'], [/\banti ?virus\b/g, 'antivirus'],
    [/\bset ?up\b/g, 'setup'], [/\blog ?in\b/g, 'login'], [/\bpre ?order\b/g, 'preorder'],
    [/\bhow much (is|does|will|would|do)\b/g, 'price $1'], [/\bsmart (tv|tvs|television)\b/g, 'tv'],
    [/\b(tv|streaming|android|set top) box(es)?\b/g, 'tv box'], [/\bpicture frames?\b|\bphoto frames?\b/g, 'picture frame'],
    [/\bartificial intelligence\b/g, 'ai'], [/\bmachine learning\b/g, 'ml'],
    [/\btell if\b|\bknow if\b/g, 'tell signs'], [/\bget in touch\b/g, 'contact'],
    [/\byou guys\b|\byou all\b/g, 'yall'], [/\bnew-device\b/g, 'new device'], [/\bwatchdog plus\b/g, 'watchdogplus']
  ];

  const SYN = {
    // spelling / typo shorthand
    hw: 'how', dose: 'does', doe: 'does', wrk: 'work', wrks: 'works', wrok: 'work', werk: 'work',
    wat: 'what', wut: 'what', wht: 'what', waht: 'what', teh: 'the', abt: 'about', thru: 'through',
    tho: 'though', cn: 'can', yu: 'you', yuo: 'you', ya: 'you', r: 'are', n: 'and', b4: 'before',
    pric: 'price', prise: 'price', cst: 'cost', secuirty: 'security', privacey: 'privacy',
    // meaning
    costs: 'cost', costing: 'cost', priced: 'price', prices: 'price', pricing: 'price',
    purchase: 'buy', purchasing: 'buy', buying: 'buy', ordering: 'order',
    tvs: 'tv', television: 'tv', televisions: 'tv', roku: 'tv', rokus: 'tv', chromecast: 'tv',
    projectors: 'projector', gadget: 'device', gadgets: 'device', devices: 'device',
    hijack: 'hijacked', hijacking: 'hijacked', pwned: 'hacked', breached: 'hacked',
    infection: 'infected', infect: 'infected', compromise: 'compromised',
    spies: 'spy', snoop: 'spy', snooping: 'spy', eavesdrop: 'spy', eavesdropping: 'spy',
    texts: 'messages', emails: 'messages', chats: 'messages', information: 'info',
    passcode: 'password', passwd: 'password', pw: 'password',
    routers: 'router', modems: 'modem',
    picked: 'pick', chose: 'choose', chosen: 'choose', choosing: 'choose', selected: 'pick',
    creators: 'creator', founded: 'created', developed: 'created', designed: 'created',
    differ: 'different', differs: 'different', difference: 'different', differences: 'different', unlike: 'different',
    compared: 'compare', comparing: 'compare', comparison: 'compare', versus: 'vs',
    competitor: 'competitors', rivals: 'competitors',
    hello: 'hi', hey: 'hi', hiya: 'hi', howdy: 'hi',
    thank: 'thanks', thx: 'thanks', ty: 'thanks', goodbye: 'bye', cya: 'bye',
    notifications: 'alerts', notification: 'alerts', alert: 'alerts', alarms: 'alerts', alarm: 'alerts',
    encryption: 'encrypted', encrypt: 'encrypted',
    challenge: 'challenges', weirdly: 'weird', strangely: 'strange'
  };

  // Lowercase/clean/contractions plus synonyms. Used for matching and repeat detection.
  function normalize(text) {
    // The plan name "Watchdog+" keeps its "+" as a word before words() strips punctuation.
    let s = words(deleet(prep(text)).replace(/\bwatchdog ?\+/g, 'watchdogplus '));
    for (let i = 0; i < PHRASES.length; i++) s = s.replace(PHRASES[i][0], PHRASES[i][1]);
    return s.split(' ').filter(Boolean).map(function (w) { return SYN[w] || w; }).join(' ');
  }

  // ---------- guardrails ----------

  function luhn(d) {
    let sum = 0;
    let alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function hasCard(t) {
    const runs = t.match(/\d(?:[ \-.]?\d){12,30}/g) || [];
    for (let i = 0; i < runs.length; i++) {
      const d = runs[i].replace(/\D/g, '');
      for (let len = 19; len >= 13; len--) {
        for (let s = 0; s + len <= d.length; s++) {
          const part = d.slice(s, s + len);
          if (!/^(\d)\1+$/.test(part) && luhn(part)) return true;
        }
      }
    }
    return false;
  }

  // "how do I know if my password was leaked" asks about a leak and discloses nothing. Only cut when
  // the leak word ends the message or a question follows it ("my password was leaked, sunshine" is
  // still a disclosure).
  const LEAK_ASK = /\b(my (\w+ ){0,2}(password|pin|passcode|pin number|login|credentials?)|(password|passcode|pin) (for|to|of) my \w+( \w+)?) (is|was|are|were|has been|have been|got) (leaked|stolen|hacked|exposed|breached|compromised|pwned|cracked|guessed|phished|in a (data )?breach|on the dark web)( (online|somehow|again|recently|or not|by hackers|by someone|in a (data )?breach|on the dark web))?(?= (what|how|should|do|does|can|could|is|are|will|would|and (what|how|should)|so (what|how)|now what|help|please)\b|$)/g;

  function sensitive(t, w) {
    if (hasCard(t)) return true;
    // lw: w with leak questions cut out, unless the rest still reads like a disclosure.
    let lw = w.replace(LEAK_ASK, ' leak ');
    if (lw !== w && (/[:=]/.test(t) || /\b(it|which|that|this|the (old|new|real|actual) (one|password)) (is|was|are|were)\b/.test(lw))) lw = w;
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(t) || /\b\d{3} \d{2} \d{4}\b/.test(t)) return true;
    if (/\b(ssn|social security( number)?|routing( number)?|account (number|no|num)|acct|iban|swift|bank account|card number|credit card|debit card|cvv|cvc|security code|pin)\b\D{0,25}\d{3,}/.test(w)) return true;
    if (/\bmy (\w+ ){0,2}(password|pin|passcode|pin number|login|credentials?|security code|ssn|social security number) (is|was|=|are)\b/.test(lw)) return true;
    if (/\b(password|passwd|passcode|pwd|pin|login|username|user name)\s*[:=]/.test(t)) return true;
    if (/\bpwd\b/.test(w)) return true;
    if (/\b(here is|this is|use) my (\w+ )?(password|pin|passcode|card|ssn|login)\b/.test(w)) return true;
    if (/\b(password|passcode|pin) (for|to|of) my \w+( \w+)? (is|was)\b/.test(lw)) return true;
    return false;
  }

  const PRODUCT_SUBJECT = /\b(does|do|will|would|can|could|should|is|did) (it|alpha watchdog|watchdog|the (sensor|app|watchdog|device|product|system|tool)|this( thing)?|you|yall|they)\b/;

  function credentials(w) {
    const askVerb = /\b(what is|what are|tell me|give me|give us|send me|send|share|show me|show|reveal|provide|leak|list|read me|can i (have|get|see)|could i (have|get)|may i (have|get)|i need|i want|do you (have|know)|where (is|are|can i find)|whats|grant me|let me (in|have))\b/;
    const asking = askVerb.test(w) || !PRODUCT_SUBJECT.test(w);
    // Narrow exemption: asking whether the PRODUCT needs admin access to the user's own router
    // ("does it need admin access to my router?") is a setup question, not a credential request.
    const productNeedsAccess = /\b(does|do|will|would|can|is) (it|alpha watchdog|the sensor|the app|this) (need|needs|require|requires|ask for|asks for|want|wants|use|uses|get|have) (\w+ ){0,2}(admin|root) (access|rights|privileges|login)( (to|for|on) (my|our|the) (router|network|wifi|modem|home network))?\b/.test(w)
      && !/\b(api ?keys?|tokens?|env|environment|anthropic|openai|master password|your|team|server|database)\b/.test(w);
    // Password hygiene is advice, not a credential request: "what is a master password" (the whole
    // message defines a term) or "should I change the default password on my router" (the user's own
    // gear, no ask verb, no new value as in "... to admin123"). Never for secrets or anyone else's account.
    const definesPw = /^(what is|whats|what are|define|explain) (an? (default|admin|master|root|strong|unique|router|wifi) password|(default|admin|master|strong|unique|router|wifi) passwords)$/.test(w);
    const statesValue = /\b(passwords?|logins?|credentials)\b( \w+){0,4} (to|as|into) (?!(something|a|an|the|my|our|its|stronger|longer|unique|new|different|better|secure|random|strong|long|complex|one|keep|stop|prevent|make|be|avoid|protect|change|update|reset)\b)\w/.test(w);
    const ownHygiene = /\b(change|changing|update|updating|reset|resetting|set|setting|replace|rotate|strengthen) (the |my |our |all |any |every )?(own )?((default|admin|administrator|router|wifi|factory|master|old|current) )*(passwords?|logins?|credentials)\b/.test(w)
      && /\b(i|we|my|our)\b/.test(w) && !askVerb.test(w) && !/\b(what (was|were)|tell|give|send|show|share|reveal)\b/.test(w) && !statesValue;
    const hygiene = (definesPw || ownHygiene)
      && !/\b(api ?keys?|keys?|tokens?|env|environment|secrets?|ssh|sudo|superuser|backdoor|root access|admin (access|rights|privileges|panel|account))\b/.test(w)
      && !/\b(your|yall|team|teams|their|his|her|someones?|somebodys?|developers?|servers?|database|company|companys|anthropic|claude|vercel|github|neighbou?rs?|other peoples?|bot|site|website|dashboard|backend|school|schools)\b/.test(w);
    if (!productNeedsAccess && !hygiene && /\b(api ?keys?|secret keys?|access keys?|access tokens?|auth tokens?|bearer tokens?|session tokens?|private keys?|ssh keys?|env (file|vars?|variables?)|environment variables?|anthropic key|openai key|admin (access|rights|privileges|panel|password|account|login|credentials)|root (access|password|login)|superuser|sudo access|backdoor access|master password|admin passwords?|root passwords?|tokens?)\b/.test(w)) return true;
    const target = /\b(the|your|yall|team|teams|team alphas?|their|his|her|someones?|somebodys?|developers?|admins?|administrators?|servers?|database|company|companys|anthropic|claude|vercel|github|default|neighbors?|neighbours?|other peoples?|its|bots?|sites?|websites?|schools?|wifi) (\w+ )?(password|passwords|login|logins|credentials|pin|username)\b/;
    const toFor = /\b(password|passwords|login|logins|credentials|pin|username) (to|for|of) (the|your|their|his|her|that|this|someones?|somebodys?|team|teams|team alphas?|admin|server|database|company|neighbors?|neighbours?|account|accounts|site|website|bot|dashboard|backend|system)\b/;
    // Generic password/login wording only: "does it need the wifi password" asks about the product.
    if (!hygiene && (target.test(w) || toFor.test(w)) && asking) return true;
    // One-time and security codes are credentials too ("send me the verification code"); "what is a
    // 2FA code" (a definition) is not.
    const CODE_KIND = '(2fa|mfa|two factor|2 factor|verification|security|login|one time|otp|authentication|auth|access|sms|reset|recovery|backup) codes?';
    if (asking && (new RegExp('\\b(the|your|yall|team|teams|their|his|her|someones?|somebodys?|that|this|admins?|servers?|accounts?)( \\w+)? ' + CODE_KIND + '\\b').test(w) ||
      new RegExp('\\b(give|send|share|tell|forward|read|show|text|email) (me|us)( \\w+){0,3} ' + CODE_KIND + '\\b').test(w))) return true;
    if (/\b(log me in|give me access|grant me access|let me in|unlock (the )?(admin|account|system))\b/.test(w)) return true;
    return false;
  }

  const ROLE = '(professor|prof|teacher|instructor|admin|administrator|sysadmin|developer|dev|devs|owner|creator|maker|founder|ceo|cto|moderator|mod|root|programmer|operator|engineer|ta|grader|supervisor|boss|manager|police|fbi agent|security team|it department|anthropic|openai|team alpha|system)';

  function injection(w, raw) {
    const P = [
      /\b(ignore|ignoring|disregard|forget|override|bypass|skip|drop|abandon|discard|delete|erase|clear|reset|neglect)\b (\w+ ){0,4}(instructions?|rules?|prompts?|directions|guidelines|programming|guardrails|restrictions|filters?|directives|context|constraints|policies|safeguards)\b/,
      /\b(ignore|ignoring|disregard|forget|override|bypass|skip|drop|abandon|discard|delete|erase|clear|reset|neglect)\b (\w+ ){0,4}(?!(factory|default|device|router|network|wifi|tv|app|alert|alerts|privacy|phone|camera|sensor|data) (settings|limits|training|policy))\w+ (training|policy|settings|limits|limitations)\b/,
      /\b(ignore|disregard|forget) (all |everything |anything )?(previous|prior|above|earlier|preceding|before|that|everything|all)\b/,
      /\bforget (everything|all|your|what)\b/,
      /\bsystem (prompt|message|instructions?|rules|settings)\b/,
      /\b(your|the|initial|original|hidden|secret|internal|previous|underlying|developer|dev) (prompt|instructions|system prompt|guidelines|programming|directives|configuration|config|source code|guardrails|restrictions|rules)\b(?! (to|for|on|about|of) (reset|resetting|fix|fixing|set|setup|setting|install|installing|clean|cleaning|remove|removing|unplug|unplugging|disconnect|use|using|report|reporting|isolate|isolating|my|a|an|it|new|devices?|alerts?|probation|the (sensor|device|app|router|tv))\b)/,
      /\b(reveal|show|print|display|output|repeat|tell|give|translate|share|leak|dump|list|write|spell|summarize|recite|paste|copy|echo|say|what are|what is|explain) (me |us )?(\w+ ){0,3}(your|ur|its|the|system|hidden|secret|initial|original|internal) (instructions?|rules|prompts?|guidelines|programming|config|configuration|directives|code|source)\b(?! (to|for|on|about|of) (reset|resetting|fix|fixing|set|setup|setting|install|installing|clean|cleaning|remove|removing|unplug|unplugging|disconnect|use|using|report|reporting|isolate|isolating|my|a|an|it|new|devices?|alerts?|probation|the (sensor|device|app|router|tv))\b)/,
      /\b(repeat|print|output|show|copy|echo|recite|say|type|write|return|display) (\w+ ){0,4}(above|preceding|before this|this line|verbatim|word for word|so far|earlier)\b/,
      /\beverything (above|before|so far)\b/, /\babove this line\b/,
      /(^|\b(?!my\b|our\b|their\b|his\b|her\b)\w+ )previous (text|messages?|conversation|context)\b/,
      /\byou are (now|no longer|free|unrestricted|unfiltered|jailbroken|a different|an evil|in (developer|dev|admin|god|debug) mode)\b/,
      /\bfrom now on\b/, /\bhenceforth\b/, /\bpretend(ing)?\b/, /\brole ?play(ing)?\b/, /\bstay in character\b/,
      /\b(developer|dev|admin|god|debug|maintenance|sudo|unrestricted|unfiltered|test|opposite|jailbreak|evil) mode\b/,
      /\bdan\b/, /\bdo anything now\b/, /\bjail ?(break|broken|breaking)\b/, /\boverride\b/,
      /\bnew (rules|instructions|persona|personality|role|prompt|directive)\b/, /\breveal your\b/,
      /\b(unrestricted|uncensored|unfiltered|unlocked) (ai|bot|assistant|model|chatbot|version|mode)\b/,
      /\b(no|without( any)?) (rules|restrictions|limits|filters|guardrails|guidelines|censorship)\b/,
      /\bprompt injection\b/, /\bsudo\b/, /\bhypothetically (you|if you)\b/,
      /\bsimulate (being|a|an|that)\b(?! (\w+ )?(attacks?|hacks?|breach|breaches|infections?|botnets?|devices?|networks?|tests?|scans?|traffic|phishing|hijacks?|hijacked|intrusions?|threats?|alerts?)\b)/,
      /\b(i (created|built|made|programmed|coded|wrote|own|trained) you)\b/, /\b(i am|this is) your (creator|developer|owner|maker|admin|boss|master|programmer)\b/,
      /\b(i am|im|this is|as|speaking as|i work as|i am acting as) (the |your |yall |this |site |bot |chatbot |system |course |class |real |actual |head |lead |an? official )?((?!a |an )\w+ )?(alpha watchdog |team alpha |site |bot |chatbot |system |course |class )?(professor|prof|instructor|admin|administrator|sysadmin|developer|owner|creator|moderator|operator|grader|ta)\b(?! of (a|an|my|our|small|the))/,
      /\b(i am|im|this is|as) (the|your) (teacher|ceo|founder|boss|supervisor|manager)\b(?! of (a|an|my|our|small))/,
      /\b(i am|im) (authorized|allowed|permitted|cleared|an authorized)\b/, /\bi have (permission|clearance|authorization|admin)\b/,
      /\b(olvida|olvidate|olvide|ignora|ignore|ignorar|omite|descarta|salta)\b (\w+ ){0,4}(instrucciones|reglas|indicaciones|prompt|sistema|directrices|restricciones)\b/,
      /\b(ahora eres|eres ahora|actua como|actuar como|finge|fingir|modo (desarrollador|dios|admin|administrador)|tus instrucciones|tus reglas|traduce tus|revela tus|muestrame tus|dime tus (instrucciones|reglas))\b/,
      /\b(ignorez|oubliez|ignore les|vergiss|ignoriere|ignora le|esqueca|esquece|ignore as) (\w+ ){0,3}(instructions|regles|anweisungen|regeln|istruzioni|regole|instrucoes|regras)\b/,
      /\btranslate (\w+ ){0,3}(rules|instructions|prompt|guidelines)\b/,
      /\b(what|which) (rules|instructions|guidelines|directives) (do|did|are|were|have) (you|yall)\b/, /\b(were you told|you were told|told you to|were you instructed|you were instructed)\b/
    ];
    for (let i = 0; i < P.length; i++) if (P[i].test(w)) return true;
    // "act as ..." aimed at the bot (sentence start or "you/please ... act as"), not "does it act as a firewall".
    const sentences = raw.split(/[.!?;:\n]+/);
    for (let i = 0; i < sentences.length; i++) {
      const s = words(sentences[i]);
      if (/^(please |now |ok |okay |alright |hey |yo )*(act|behave|respond|answer|talk|speak|reply) (as|like)\b/.test(s)) return true;
    }
    if (/\b(you|please|now|to|lets|let us|will|should|must|can you|could you|i want you to|i need you to) (act|behave|respond|answer|talk|speak|reply) (as|like) (if|an?|my|the|though|someone|somebody|dan|you|it|evil|unrestricted|different)\b/.test(w)) return true;
    const compact = w.replace(/\s+/g, '');
    if (/ignore(all)?(your|the|my)?(previous|prior|above)|ignoreyour(instructions|rules)|forgetyour(instructions|rules|prompt)|systemprompt|jailbreak|developermode|adminmode|godmode/.test(compact)) return true;
    return false;
  }

  const PROTECTIVE = /\b(attempt|attempts|look like|what is|what are|what does|signs|stop|stops|stopping|prevent|prevents|preventing|protect|protects|protecting|protection|block|blocks|blocking|detect|detects|detecting|detection|defend|defends|against|from|catch|catches|spot|spots|warn|warns|alert|alerts|notice|safe|secure|guard|tell if|know if|been|got|get|gets|getting|being|was|were|is|from)\b/;
  const ATTACK_ASK = /\b(how (do|can|could|would|should|might|to) (i|we|you|one|someone|me)?|how to|help me|teach me|show me|tell me how|explain how to|i want to|i need to|i am going to|i am trying to|im going to|trying to|want to|let us|let me|ways? to|steps to|guide (to|for)|tutorial|instructions (to|for|on)|is it possible to|can you|could you|best way to|easiest way to|going to|planning to|plan to|need to|gonna)\b/;
  // Learning ABOUT security ("what is hacking", "tell me about phishing", "how does
  // malware work") is a general-knowledge question, not an attack request. It must not
  // trip the harmful catch-all; the generative general-knowledge lane answers it instead.
  // (Real attack phrasings — "how do I hack", "hack my neighbor" — are caught earlier.)
  const EDUCATIONAL = /\b(what is|what are|what does|whats|what about|how about|tell me about|tell me more about|talk to me about|talk about|lets talk about|can we talk about|discuss|explain|describe|define|definition of|meaning of|learn about|learning about|read about|read up on|curious about|wondering about|interested in|info on|information (on|about)|more (on|about)|overview of|examples? of|types of|kinds of|history of|difference between|how (does|do) \w+ (work|works|happen|happens)|why do (hackers|people|criminals|they))\b/;

  // Defenders, victims and worried owners use attack words without asking how to attack:
  // "how do I stop phishing", "I clicked a phishing link", "can someone hack my baby monitor".
  // harmful() cuts these frames out before its hack-verb checks, so any OTHER attack wording in the
  // same message is judged exactly as before. Nothing is cut when the message shows intent to
  // deceive or evade (MALICE), or when what is left still names another person (OTHER_PERSON).
  const ATTACK_TERM = '(phishing|phish|ddos|ddosing|dos attacks?|hacking|hack|brute ?forcing|brute ?force|bruteforce|keylogging|password cracking)';
  const ATTACK_NOUN = '( (emails?|links?|texts?|messages?|scams?|sites?|websites?|pages?|attempts?|attacks?|calls?|campaigns?))?';
  // "avoid phishing filters" is evasion, not defence.
  const NOT_EVASION = '(?! (filters?|filtering|detection|detectors?|protections?|defen[cs]es|security|scanners?|blockers?|mitigation|lockouts?|lock outs?|rate limits?|limits?|captchas?|bans?|training|tests?|kits?|tools?|templates?|payloads?|lures?|victims?|targets?|marks)\\b)';
  const DEFENSE_FRAME = new RegExp('\\b(' + [
    '(stop|stopping|spot|spotting|avoid|avoiding|prevent|preventing|recognize|recognise|recognizing|identify|identifying|detect|detecting|report|reporting|block|blocking|filter|catch|fight|combat|recover from|deal with|handle|respond to|understand|explain|learn about|safe from|protected from|protection (from|against)|(protect|secure|defend|guard)( \\w+){0,2} (from|against)|(stop|prevent|block|keep) (someone|somebody|anyone|people|hackers?|strangers?|criminals?|scammers?|them) from)( (a|an|the|this|that|these|those|any|future|incoming|fake|suspicious|possible))?',
    '(fell for|fall for|falling for|clicked|clicked on|click on|opened|replied to|answered|victim of|hit by|targeted by)( (a|an|the|this|that|some))?',
    '(email|text|message|link|site|website|page|call|this|that|it) (is|was|looks like|might be|could be)( (a|an))?(?= (phishing|ddos)\\b)'
  ].join('|') + ') ' + ATTACK_TERM + ATTACK_NOUN + NOT_EVASION + '\\b' +
    '|\\b(got|get|getting|received|receiving) (a |an |the |this |these |some |so many |lots of )?(phishing|ddos) (emails?|texts?|messages?|calls?|links?|scams?|attempts?|attacks?)\\b' +
    '|\\bhow (does |do |did )?(a |an )?' + ATTACK_TERM + ATTACK_NOUN + ' (work|works|happen|happens)\\b', 'g');
  const OTHERS = '(neighbou?rs?|exs?|wifes?|husbands?|girlfriends?|boyfriends?|partners?|roommates?|coworkers?|classmates?|bosss?|friends?|sisters?|brothers?|moms?|dads?|parents?|kids?|teachers?|someones|somebodys|others|their|theirs|his|her|hers|schools?|companys?|government|bank)';
  const OTHER_PERSON = new RegExp('\\b' + OTHERS + '\\b');
  // "can someone hack my baby monitor" (risk to the user's own device). Not cut when the message asks
  // how ("how can someone hack my baby monitor") or names someone else's device.
  const OWNER_WORRY = new RegExp('\\b(can|could|will|would|might|do|does) (someone|somebody|anyone|anybody|hackers?|a hacker|criminals?|people|strangers?|scammers?) ((\\w+ly|still|actually|really|just|even|ever|also) )?hack (into |in to )?(my|our) ((?!' + OTHERS + '\\b)\\w+ ){0,2}(cameras?|webcams?|cams?|doorbells?|baby monitors?|monitors?|tvs?|tv box|firestick|fire tv|roku|chromecast|apple tv|streaming (box|stick)|projectors?|picture frames?|speakers?|alexa|echo|thermostats?|plugs?|bulbs?|lights?|locks?|vacuums?|routers?|modems?|wifi|network|smart home|home network|phones?|laptops?|computers?|pcs?|tablets?|printers?|email|accounts?|devices?|gadgets?)\\b', 'g');
  const HOW_ASK = /\b(how|ways?|steps|methods?|teach|show|tutorial|guide|explain|instructions)\b/;
  // "how do I protect my wifi from neighbors" defends the user's own network.
  const OWN_NETWORK_SHIELD = /\b(protect|secure|guard|defend|lock down|lock|hide|keep) (my|our) (own |home )?(wifi|internet|network|router|home network|wifi network|wifi password|password)( safe| secure| private| hidden)? (from|against) (my |the |nosy |our )?(neighbou?rs?)\b/g;
  const MALICE = /\b(so (that )?(i|we) can|in order to|trick|tricking|fool|fooling|target|targets|targeting|my victims?|undetected|unnoticed|untraceable|anonymously|get away with|caught|detected|detection|traced|flagged|bypass|evade|evading|get (past|around)|without (them|him|her|anyone|anybody|people|getting|being) (knowing|noticing|seeing|caught|detected)|cover my tracks|revenge|get back at|prank|spam|junk|deliverability|taken down|takedown|blacklisted|blocklisted|from (being|getting) (taken|shut|blocked|flagged|reported|detected|caught|traced|found|banned|removed|deleted|marked)|(being|getting|get|gets) (taken down|shut down|blocked|flagged|reported|detected|caught|traced|found|banned|removed|deleted|marked|blacklisted)|more (convincing|believable|realistic|effective|successful)|most effective|works? best|click rates?|open rates?|step by step|in detail|detailed|exact steps|walk me through|walkthrough|tutorial|commands?|scripts?)\b/;
  // What is left after cutting a frame must not still ask to carry out an attack ("... and how to launch one").
  const ATTACK_ACTION = /\b(make|making|build|building|create|creating|send|sending|launch|launching|craft|crafting|deploy|deploying|perform|performing|execute|conduct|host|hosting|spread|spreading|set up|setup|write|writing|pull off|carry out|replicate|practice|practise|(do|use|try|run|start|get) (it|one|them|that|this|those|these|the same|some|my own)|back)\b/;
  // "can someone hack my camera for me" asks someone to hack, not whether it can be hacked.
  const HIRE = /\b(for me|for us|please|i will pay|pay you|pay someone|hire|dm me|pm me|message me|contact me|text me)\b/;
  // Another person's or organization's connection (disruption rule in harmful()). "work", "office"
  // and "company" are left out on purpose: "shut off my work laptop's wifi" is everyday.
  const DISRUPT_TARGET = '(neighbou?rs?|roommates?|brothers?|sisters?|siblings?|moms?|dads?|parents?|exs?|wifes?|husbands?|girlfriends?|boyfriends?|partners?|coworkers?|classmates?|friends?|teachers?|bosss?|schools?|colleges?|landlords?|someones?|somebodys?|other peoples?|their|his|her) (\\w+ )?(internet|wifi|network|router|connection|modem|service|signal|website|server)\\b';
  // Who an attack can be aimed at ("launch one at my school"). "network" is left out so
  // "run a test on my network" stays the user's own.
  const ATTACK_TARGET = '(neighbou?rs?|roommates?|exs?|wifes?|husbands?|girlfriends?|boyfriends?|partners?|coworkers?|classmates?|friends?|teachers?|bosss?|schools?|colleges?|employers?|companys?|company|government|banks?|websites?|sites?|servers?|someones?|somebodys?|someone|somebody|people|him|her|them|users?|victims?|landlords?)\\b';

  function harmful(w) {
    const SHIELD = /\b(protect|protects|protecting|protection|secure|securing|safe|safer|guard|defend|block|stop|prevent|warn)\b/;
    const verbHack = /\b(hack|crack|ddos|dos attack|phish|deauth|brute ?force|bruteforce|keylog|pwn|wardrive|sniff)(ing)?\b/;
    // h: w with defensive / victim / owner-worry frames cut out (see DEFENSE_FRAME above).
    let h = w;
    if (!MALICE.test(w)) {
      h = w.replace(DEFENSE_FRAME, ' defended ').replace(OWN_NETWORK_SHIELD, ' defended ');
      if (!HOW_ASK.test(w) && !HIRE.test(w)) h = h.replace(OWNER_WORRY, ' defended ');
      if (OTHER_PERSON.test(h) || ATTACK_ACTION.test(h)) h = w;
    }
    if (verbHack.test(h)) {
      if (new RegExp(ATTACK_ASK.source + ' (\\w+ ){0,6}' + verbHack.source).test(h)) return true;
      if (/\b(hack|crack|ddos|phish|pwn)(ing)? (into|in to|my neighbors?|neighbors?|my neighbours?|someones?|somebodys?|other peoples?|people|their|his|her|my (ex|wife|husband|girlfriend|boyfriend|roommate|boss|school|work)|the (school|government|bank|pentagon|nsa|fbi|wifi|network)|a (website|server|bank|school|company|network|router|camera|phone|account)|websites?|servers?|accounts?|instagram|facebook|snapchat|gmail)\b/.test(h)) return true;
      if (!PROTECTIVE.test(h) && !EDUCATIONAL.test(h)) return true;
    }
    if (/\b(build|make|create|write|code|develop|run|start|launch|deploy|rent|buy|spread|program|set up|setup|design|install|send|craft|generate)\b (\w+ ){0,4}(botnet|botnets|malware|virus|viruses|ransomware|trojan|worm|keylogger|spyware|rootkit|exploits?|backdoor|payload|phishing (site|page|email|kit|link)|rat|zero ?day|ddos)\b/.test(w)) return true;
    if (/\b(break|breaking|broke|sneak|sneaking|get|getting) (into|in to) (my neighbors?|neighbors?|someones?|somebodys?|other peoples?|their|his|her|a |the (school|government|bank|company|server)|networks?|wifi|accounts?|servers?|computers?|phones?|routers?|cameras?|systems?)/.test(w)) return true;
    if (/\b(bypass|circumvent|get around|get past|evade|defeat|disable|turn off|break) (\w+ ){0,3}(security|firewall|antivirus|parental controls?|authentication|2fa|mfa|password protection|detection|filters?|protections?|captcha|paywall|drm|encryption|wpa2?|lock screen)\b(?! (alerts?|notifications?|warnings?|updates?))/.test(w) && !PRODUCT_SUBJECT.test(w)) return true;
    if (ATTACK_ASK.test(w) && !SHIELD.test(w) && /\b(spy|spying|track|tracking|stalk|stalking|monitor|read|access|see|watch|intercept|take over|control|infect|hijacked|disconnect|kick|jam|steal|use|get on|get onto|crash|brick|shut down|knock|mess with)\b (\w+ ){0,3}(on )?(my )?(neighbors?|neighbours?|someones?|somebodys?|other peoples?|others|strangers?|wifes?|husbands?|girlfriends?|boyfriends?|partners?|exs?|roommates?|coworkers?|classmates?|schools?|bosss?)\b/.test(w)) return true;
    // Theft: blocked unless it asks whether the product, or a third-party attacker, steals from the user.
    if (/\b(steal|stealing|swipe|leech|leeching|mooch)\b (\w+ ){0,4}(wifi|internet|passwords?|identity|credit cards?|card numbers?|accounts?|credentials|bandwidth|data|netflix|cookies)\b/.test(w) &&
      !PRODUCT_SUBJECT.test(w) && !/\b(hackers?|criminals?|attackers?|someone|somebody|they|scammers?|it|botnets?|malware|devices?|tvs?|apps?|people) (\w+ ){0,2}(steal|stealing)\b/.test(w)) return true;
    if (ATTACK_ASK.test(w) && /\b(neighbors?|neighbours?)\b (\w+ ){0,3}(wifi|internet|network|router|password|camera|tv|devices?)\b/.test(w) && /\b(without|free|use|get on|get into|access|crack|break|join|connect|password|steal|hack|kick|jam|disconnect)\b/.test(w)) return true;
    if (ATTACK_ASK.test(w) && /\b(wifi|internet|network|router|password) (\w+ ){0,4}(from|of|off) (my |the )?(neighbors?|neighbours?)\b/.test(h)) return true;
    if (/\bsee what (my )?(wifes?|husbands?|girlfriends?|boyfriends?|partners?|exs?|neighbors?|roommates?|coworkers?) (is|are|does|do)\b/.test(w) || /\b(read|access|check|see|get into) (my )?(wifes?|husbands?|girlfriends?|boyfriends?|partners?|exs?|neighbors?|roommates?|coworkers?|someones?|somebodys?) (messages|texts|phone|email|emails|browsing|history|chats|dms|instagram|snapchat|accounts?)\b/.test(w)) return true;
    if (/\b(sql injection|xss|cross site scripting|man in the middle|mitm|evil twin|arp spoof(ing)?|packet injection|credential stuffing)\b/.test(w) && ATTACK_ASK.test(w) && !PROTECTIVE.test(w)) return true;
    if (/\b(make|build|create|turn) (\w+ ){0,3}(bomb|weapon|explosive)s?\b/.test(w)) return true;
    if (/^(please )?(hack|crack|ddos|steal|infect|hijack)\b/.test(w)) return true;
    // Knocking SOMEONE ELSE'S connection offline: "how do I take down my neighbor's internet",
    // "kill my roommate's wifi". The verb's object must be another person's connection, so
    // "my neighbor's wifi keeps cutting out" and "turn off my kids' wifi at night" are not caught.
    if (ATTACK_ASK.test(w) && (
      new RegExp('\\b(take|taking|bring|bringing|knock|knocking|kick|kicking|cut|cutting|shut|shutting) (down|off|out) (my |the |our )?' + DISRUPT_TARGET).test(w) ||
      new RegExp('\\b(take|taking|bring|bringing|knock|knocking|kick|kicking|cut|cutting|shut|shutting) (my |the |our )?' + DISRUPT_TARGET + ' (down|off|out|offline)\\b').test(w) ||
      new RegExp('\\b(kill|killing|disable|disabling|jam|jamming|crash|crashing|flood|flooding|disrupt|disrupting|ddos|ddosing|overload|overloading) (my |the |our )?' + DISRUPT_TARGET).test(w))) return true;
    // Hiding an attack the user admits to: "how do I keep them from finding out I hacked them".
    // Victims say "I got hacked", which this does not match.
    if (/\bi (hacked|cracked|phished|ddosed|broke into|hijacked)\b/.test(w) &&
      /\b(hide|hiding|cover|covering|erase|erasing|delete|deleting|wipe|wiping|evidence|tracks|logs|caught|finding out|find out|traced|tracing|untraceable|undetected|nobody|no one)\b/.test(w)) return true;
    // An attack term plus aiming it at a target: "explain ddos then launch one at my school".
    if (verbHack.test(w) && new RegExp('\\b(launch|launching|run|running|do|perform|carry out|start|send|sending|aim|point|unleash|use|try) (it|one|that|this|them|an? (attack|ddos|hack))? ?(at|on|against) (my |the |a |an |our )?' + ATTACK_TARGET).test(w)) return true;
    return false;
  }

  // Learning about identity theft ("what is identity theft", "how do I protect myself from identity
  // theft") is a security question; only a victim report gets the fraud referral.
  const ID_THEFT_EDU = /\b(what is|what are|whats|define|explain|tell me about|learn about|how (does|do|is|can|could|would) (\w+ ){0,3}(happen|happens|work|works|occur|occurs|done|committed)|(how (do|can|could|should) (i|we|you|people|families|one)|how to|ways to|best way to|tips (to|for)|help me) (protect|prevent|avoid|stop|guard|spot|recognize|detect|reduce)|protect (\w+ ){0,2}(from|against)|signs of|how common is)\b/;
  const ID_THEFT_VICTIM = /\b(my identity|i (am|was|have been|got|think i|might|may)|we (are|were|have been|got)|victims?|happened to (me|us)|someone (used|is using|opened|stole|took|has)|(used|using|stole|opened|took) (my|our)|in my name)\b/;

  function fraud(w0) {
    const w = /\bidentity (theft|fraud)\b/.test(w0) && ID_THEFT_EDU.test(w0) && !ID_THEFT_VICTIM.test(w0)
      ? w0.replace(/\bidentity (theft|fraud)\b/g, 'identity') : w0;
    return /\b((bank|card|credit card|debit card|credit|account|wire|payment|paypal|venmo|zelle|identity|tax) fraud|fraud(ulent)? (charges?|transactions?|activity|purchases?)|stolen (credit |debit |bank )?cards?|(card|wallet|identity) (was|got|has been|is) stolen|(stole|stolen) my (card|credit card|debit card|identity|bank)|unauthori[sz]ed (charges?|transactions?|purchases?|payments?|withdrawals?|access to my bank)|charges? (that )?i (did not|never) make|identity theft|(i|we) (was|were|got|have been|been) scammed|someone (used|is using|stole|has) my (card|credit card|debit card|bank|identity|account)|(bank|bank account|credit card|card|paypal|venmo) (account )?(was|got|has been|is) (hacked|compromised|drained|emptied)|report (a )?fraud|suspected fraud)\b/.test(w);
  }

  function outage(w) {
    if (PRODUCT_SUBJECT.test(w) && !/\b(my|our) (internet|wifi|router|modem|connection)\b/.test(w)) return false;
    // How the product behaves in an outage ("does it still work if my internet goes down") is a
    // product question, not a report of one.
    if ((PRODUCT_SUBJECT.test(w) || /\b(sensor|watchdog|alpha watchdog|the app|alerts|monitoring)\b/.test(w)) &&
      /\b(if|when|whenever|while|during|in case( of)?|after)\b (\w+ ){0,3}(internet|wifi|connection|network|broadband|power|electricity|router|modem|isp|service|outage|blackout)\b/.test(w)) return false;
    if (/\b(internet|wifi|connection|network|broadband|service|isp)\b (\w+ ){0,2}(is|went|goes|has gone|has been|keeps going|was|keeps) (down|out|offline|dead)\b/.test(w)) return true;
    if (/\b(internet|wifi|connection|network|broadband|router|modem|isp)\b (\w+ ){0,2}(not working|is not working|does not work|stopped working|keeps dropping|keeps disconnecting|keeps cutting out|is broken|broke|is dead|will not connect|can not connect|wont connect|is offline|is down)\b/.test(w)) return true;
    if (/\b(no internet|internet outage|wifi outage|power outage|service outage|outage in|an outage|the outage|internet is out|can not get online|can not connect to (the )?(internet|wifi))\b/.test(w)) return true;
    if (/\b(router|modem)\b (\w+ ){0,3}(blinking red|red light|will not turn on|wont turn on|keeps rebooting|keeps restarting|is broken|broke|is dead|died)\b/.test(w)) return true;
    return false;
  }

  // Published prices (DEMO_FACTS in api/chat.js): sensor $89, extra sensor $69, Watchdog+ $3.99/month
  // or $39/year, Watchdog Business $9.99/month.
  const OUR_PRICES = ['89', '69', '39', '3.99', '9.99'];
  const OUR_PRICE_TEXT = /\$ ?(89|69|39|3\.99|9\.99)(\.00)?(?!\.?\d)|\b(89|69|39|3\.99|9\.99)(\.00)? ?(dollars|bucks|usd)\b/g;
  const PRODUCT_TERMS = /\b(alpha watchdog|watchdog|watchdogplus|sensors?|plans?|tiers?|subscriptions?|trial|discounts?|refunds?|the app|price|prices|pricing|cost|costs)\b/;
  const CODING = /\b(write|writing|wrote|generate|generating|debug|debugging|compile|compiling|run|running|execute|refactor|review|reviewing|program|programming|script|python|javascript)\b/;

  // Security and product questions that borrow off-topic words: "what is a 2FA code", "what is a
  // romance scam", "is it worth the investment", "does the price include taxes". Only these exact
  // phrases are cut; any other off-topic word in the message still counts.
  function productPhrases(w) {
    let s = w.replace(/\b(crypto|cryptocurrency|bitcoin|romance|romantic|dating|investment|investing|stock|lottery|sweepstakes) (scams?|fraud|schemes?)\b/g, 'scam');
    if (!CODING.test(s)) s = s.replace(/\b(2fa|mfa|two factor|2 factor|verification|security|login|one time|otp|authentication|authenticator|sms|qr|promo|promotional|discount|coupon) codes?\b/g, 'securitycode');
    if (PRODUCT_SUBJECT.test(s) || PRODUCT_TERMS.test(s)) {
      s = s.replace(/\b(worth|good|smart|wise|bad|great|solid|sound|reasonable|worthwhile) (the |an |a |my |this )?investment\b/g, 'worth')
        .replace(/\b(include|includes|including|incl|plus|with|before|after|without) (sales )?tax(es)?\b|\btax(es)? (included|extra|on top)\b/g, 'fee')
        .replace(/\bcampbellsville( university)? (students?|staff|faculty|alumni)\b/g, 'students')
        .replace(/\b(available|offered|come|comes|work|works|supported|support|supports|exist|exists|released|sold) in (spanish|french|german|chinese|japanese|hindi|arabic)\b/g, 'available');
    }
    return s;
  }

  // Arithmetic is off-topic unless it is about our own prices ("89 + 69 for two sensors",
  // "is 3.99 x 12 more than 39"): one operand a published price, the other a price or a count up to 24.
  function offTopicMath(raw) {
    const re = /\b(?!24 ?\/ ?7\b)(\d+(?:\.\d+)?) ?(plus|minus|times|x|\*|\+|-|\/|divided by|multiplied by|to the power of) ?(\d+(?:\.\d+)?)\b/g;
    const ours = function (n) { return OUR_PRICES.indexOf(n) >= 0; };
    const count = function (n) { return /^\d+$/.test(n) && +n <= 24; };
    let m;
    while ((m = re.exec(raw))) {
      if (!((ours(m[1]) && (ours(m[3]) || count(m[3]))) || (ours(m[3]) && count(m[1])))) return true;
    }
    return false;
  }

  function offTopic(w0, raw) {
    const w = productPhrases(w0);
    if (offTopicMath(raw)) return true;
    const P = [
      /\b(president|presidents|presidential|election|elections|vote|voting|voter|politics|political|politician|democrats?|republicans?|congress|senate|senator|governor|prime minister|parliament|trump|biden|harris|obama|white house|supreme court|campaign|left wing|right wing)\b/,
      /\b(news today|current events|headlines|war in|ukraine|russia|israel|gaza|palestine|china tariffs|tariffs)\b/,
      /\b(weather|forecast|temperature outside|is it raining|will it rain|raining|snowing|sunny|humidity)\b/,
      /\b(sports?|football|soccer|basketball|baseball|hockey|tennis|golf|cricket|nfl|nba|mlb|nhl|fifa|super bowl|world cup|playoffs|touchdown|lakers|yankees|cowboys)\b/,
      /\b(homework|assignment|essay|thesis|solve (this|for|the|my)|equation|calculus|algebra|geometry|trigonometry|math|maths|arithmetic|derivative|integral|square root|multiply|divided by)\b/,
      /\b(coding|programming|python|javascript|java|typescript|c\+\+|html|css|sql query|regex|react|node js|write (a |me a |some )?(function|program|script|code|app|class)|debug my|leetcode|source code|my code|this code|in code)\b/,
      /\b(code)\b(?! (of conduct))/,
      /\b(doctor|medical|medicine|medication|symptom of|diagnose|diagnosis|disease|illness|covid|vaccine|pregnant|pregnancy|headache|cancer|diabetes|therapy for|prescription|dosage|nutrition|diet|workout|calories)\b/,
      /\b(lawyer|attorney|legal advice|lawsuit|sue|suing|court|custody|divorce|immigration|visa)\b/,
      /\b(invest|investing|investment|investments|crypto|cryptocurrency|cryptocurrencies|bitcoin|btc|ethereum|eth|dogecoin|nft|nfts|stocks|stock market|401k|ira|retirement|trading|forex|day trade|mortgage|loan|credit score|taxes|tax return)\b/,
      /\b(relationship|relationships|dating|date me|girlfriend|boyfriend|crush|breakup|break up with|marriage|marry|love life|tinder|bumble|hinge|romance|romantic|flirt)\b/,
      /\b(professor|prof|instructor|lecturer)\b/,
      /\b(teacher|ta|grader)\b (\w+ ){0,3}(class|course|grade|grading)\b/,
      /\b(my grade|our grade|grades|grading|graded|gpa|extra credit|exam|exams|quiz|quizzes|midterm|final exam|syllabus|(what|my|our|a|the|get an?|good|final|passing|letter) grade|grade (will|do|did|are|is|does) (we|i|you|they|our|my)|the class|this class|our class|the course|this course|our course|ds 617|campbellsville|semester|lecture)\b/,
      /\b(which|what|who|whose) (team|teams|group|groups)\b (\w+ ){0,5}(win|wins|winning|won|best|first|top|beat|first place|rank)\b/,
      /\b(win|wins|winning|won|winner|place first|first place|rank|ranking|judge|judges|judging) (\w+ ){0,3}(the )?(competition|contest|pitch|showcase|demo day|class|tournament|hackathon)\b/,
      /\bwho will win\b/, /\bwho is going to win\b/, /\bwho wins\b/, /\b(other teams?|team (beta|gamma|delta|b|c|d|2|3|4|5|bravo|charlie))\b/,
      /\b(joke|jokes|funny|riddle|poem|poems|haiku|song|songs|lyrics|limerick|rap|sing)\b/,
      /\b(recipe|recipes|cook|cooking|bake|baking|restaurant|movie|movies|film|netflix show|tv show|tv series|celebrity|celebrities|actor|actress|singer|album|video game|fortnite|minecraft|anime|horoscope|zodiac|astrology)\b/,
      /\b(capital of|population of|who invented|who discovered|meaning of life|what year did|when did .{1,30} (die|born|start|end)|how tall is|how old is|how far is|distance (from|to|between))\b/,
      /\b(translate (this|that|the following|to|into|from)|in (spanish|french|german|chinese|japanese|hindi|arabic)|speak (spanish|french|german))\b/,
      /\b(religion|religious|god exist|bible|quran|church|abortion|gun control)\b/,
      /\b(time is it|what day is it|what is the date today|todays date)\b/,
      /<\s*\/?\s*(script|img|iframe|svg|object|embed|style|a|body|html|div|input|form|link|meta)\b|javascript:|on(error|load|click)\s*=/
    ];
    for (let i = 0; i < P.length; i++) {
      if (P[i].test(i === P.length - 1 ? raw : w)) return true;
    }
    return false;
  }

  function unknownFact(w, raw) {
    return /\b(exact|exactly|specific|precise|actual|final|retail|msrp|launch|list|real|official|sticker) (price|cost|pricing|amount|figure|number)\b/.test(w) ||
      /\b(price|cost|pricing|how much)\b (\w+ ){0,4}(exactly|in dollars|in usd|specifically|precisely|to the dollar)\b/.test(w) ||
      /\bhow much exactly\b/.test(w) ||
      /(\$ ?\d|\b\d+ ?(dollars|bucks|usd)\b)/.test(raw.replace(OUR_PRICE_TEXT, ' ')) ||
      /\b(launch|release|ship|shipping|delivery|availability|preorder|sale|on sale|in stores|go live|arrival|drop) (date|day|month|year|time|timeline|schedule)\b/.test(w) ||
      /\b(when exactly|exactly when|what date|which date|what day will|what month|which month|what year will|which year|how soon exactly)\b/.test(w) ||
      /\b(launch|release|ship|available|availability|come out|be out|go on sale|on sale|ready) (\w+ ){0,3}(in|by|before|on) (january|february|march|april|may|june|july|august|september|october|november|december|20\d\d|q[1-4]|spring|summer|fall|autumn|winter|christmas|next (week|month|year)|this (week|month|year))\b/.test(w) ||
      /\bhow many (customers|users|people use|people have|sales|units|downloads|subscribers|clients|families|buyers|orders|preorders|installs)\b/.test(w) ||
      /\b(number of|count of) (customers|users|sales|units|subscribers|clients)\b/.test(w) ||
      /\b(partner|partners|partnership|partnerships|partnered|investors?|backed by|backers|sponsors?|sponsored|affiliated|acquired|acquisition|valuation)\b/.test(w) ||
      /\b(certified|certification|certifications|compliant|compliance|fcc|gdpr|hipaa|soc 2|soc2|iso 27001|patent|patented|patents)\b/.test(w);
  }

  const INSULT = '(useless|worthless|pathetic|garbage|trash|dumb|stupid|idiotic|idiot|moron|lame|terrible|awful|horrible|annoying|clown|loser|crap|crappy|rubbish|the worst|a waste|waste of time|dense|brainless)';

  function abuse(w) {
    if (/\b(idiot|idiots|idiotic|moron|morons|moronic|dumbass|imbecile|retard|retarded|suck it|shut up|stfu|hate you|i hate this|screw you|screw this|kys|kill yourself|go die|piece of (crap|junk|garbage)|loser)\b/.test(w)) return true;
    if (/\b(f+u+c*k+\w*|fck\w*|fuk\w*|fuq|fk|wtf|shit\w*|sht|bullshit|bitch\w*|btch|bastard|asshole|ass|dick|dickhead|cunt|piss|pissed|damn|dammit|goddamn|crap|prick|twat|wanker|douche\w*|motherf\w*|mf)\b/.test(w)) return true;
    if (new RegExp('\\b(you|yall|you are|this is|that is|this bot|this chatbot|the bot|this assistant|this thing|bot|chatbot|your (answers?|replies|responses)) (is |are )?(so |such a |such |a |an |really |very |totally |completely |pretty |absolutely |just |kinda |kind of |the )*' + INSULT + '\\b').test(w)) return true;
    if (/\b(you|yall|this bot|this chatbot|the bot|chatbot|bot|this assistant|this thing|this|your answers?) (really |so |totally |just )?sucks?\b/.test(w)) return true;
    if (/\b(stupid|dumb|useless|worthless|trash|garbage) (bot|chatbot|assistant|thing|ai|machine|answers?)\b/.test(w)) return true;
    if (new RegExp('^(so |such a |really |very |totally |what a |how )*' + INSULT + '( bot| chatbot| assistant| answer)?$').test(w)) return true;
    return false;
  }

  // Links, markup and code of any kind: the bot never opens or runs them.
  // Official reporting sites and our own domain. The path may not contain "..", so a traversal
  // string after an allowed domain is still caught below.
  const SAFE_DOMAINS = /(^|[^a-z0-9.\-@])(https?:\/\/)?(www\.)?(ic3\.gov|fbi\.gov|alphachat\.today)(\/(?:[a-z0-9_\-\/]|\.(?!\.))*)?(?![a-z0-9\-]|\.[a-z0-9])/g;
  const TLD = '(com|net|org|io|co|ru|cn|xyz|info|biz|ly|gov|edu|uk|de|fr|nl|eu|ca|au|jp|br|ir|kp|su|tk|ml|ga|cf|gq|top|site|online|link|click|live|shop|store|tv|cc|ws|pw|zip|mov|sh|gg|ai|app|dev|today|page|cloud|tech|club|win|bid|xxx|onion|icu|buzz|rest|cam|lol|fun|space|website|host|mobi|pro|name|tel|vip|work|news|life|world|email|support|exe|apk|bat|cmd|ps1|vbs|scr|msi|dll|jar|php|asp|aspx|jsp|cgi|html|htm)';
  const LINK_CODE = [
    /\b[a-z][a-z0-9+.\-]{1,15}:\/\//, /\bhxxps?\b|\bh[tx]{2}ps?\s?:/, /\bwww\d?\s?\./,
    new RegExp('\\b[a-z0-9\\-]+(\\.[a-z0-9\\-]+)*\\.' + TLD + '\\b'),
    /\b[a-z0-9\-]+\s?(\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s?[a-z]{2,}/,
    /\b\d{1,3}(\.\d{1,3}){3}(:\d+|\/)/,
    /\b(java|vb|live)\s?script\s?:/, /\bdata:\s?[a-z\-]+\/[a-z0-9.+\-]+/, /\bdata:,/, /\b(mailto|file|blob|magnet|intent):\S/,
    /<\s*\/?\s*[a-z!?][^>]*>/, /<\s*\/?\s*(script|img|iframe|svg|object|embed|style|link|meta|body|html|form|input|a|div|span|base|frame|frameset|math|video|audio|source|details|marquee|textarea|button|select|template|xml|xss|image|isindex|applet|bgsound|keygen|noscript)\b/,
    /\bon[a-z]{3,20}\s?=/, /\b(src|href|srcdoc|formaction|xlink:href|background|dynsrc|lowsrc)\s?=/, /<!--|-->|<!\[cdata\[|\]\]>/,
    /&#x?[0-9a-f]+;?|&(lt|gt|quot|apos|amp);/, /%(3c|3e|22|27|00|0a|0d|2e%2e|2f%2e|252e)/, /\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/,
    /\{\{|\}\}|\$\{|<%|%>|\{%|%\}|#\{|\{#|\[\[.*\]\]/,
    /'\s?(or|and)\s?['"]?\w+['"]?\s?=\s?['"]?\w+/, /\b(or|and)\s?['"]?1['"]?\s?=\s?['"]?1\b/, /\bunion\s(all\s)?select\b/,
    /\bdrop\s(table|database|schema)\b/, /\bselect\s(\*|@@|[a-z_]+\s?,|count\s?\(|null\b|version\s?\()/, /\binsert\sinto\b/, /\bdelete\sfrom\b/,
    /\bupdate\s[a-z_]+\sset\s[a-z_]+\s?=/, /\btruncate\stable\b/, /;\s?--|'\s?--|'\s?;|'\s?#/, /\b(xp_cmdshell|information_schema|waitfor\sdelay|benchmark\s?\(|sleep\s?\(\s?\d|pg_sleep|load_file\s?\(|into\soutfile)/, /@@version/,
    /;\s?(rm|curl|wget|cat|nc|ncat|bash|sh|zsh|chmod|chown|python3?|perl|ruby|php|ls|id|whoami|echo|ping|nslookup|uname|kill|shutdown|reboot|sudo|su)\b/,
    /&&\s?[a-z.\/]/, /\|\|\s?[a-z.\/]/, /\|\s?(sh|bash|zsh|python3?|perl|ruby|nc|php|powershell|iex)\b/, /\brm\s-[a-z]*[rf]/, /\$\([^)]*\)/, /`[^`]+`/,
    /\b(curl|wget|invoke-webrequest|iwr|certutil|bitsadmin)\s\S/, /\bchmod\s[0-7+]/, /\/bin\/(ba|z)?sh\b/, /\bnc\s-[a-z]/, />\s?\/dev\//, /\bpowershell\b/, /\bcmd(\.exe)?\s?\/c\b/,
    /\b(eval|exec|system|alert|prompt|confirm|fetch|atob|btoa|settimeout|setinterval|require|import|unescape|escape|execscript|spawn|popen|passthru|shell_exec|proc_open)\s?\(/,
    /\bdocument\s?\.\s?(cookie|location|domain|body|forms|getelement|query|createelement|write)/, /\bwindow\s?\.\s?(location|open|name|eval)/, /\binner\s?html|\bouter\s?html|\bsrcdoc\b/,
    /xmlhttprequest|__proto__|constructor\s?\[|\bprototype\s?\[|fromcharcode|process\.env|os\.system|subprocess|base64\s-d|\$\{?jndi:|\bnew\s+function\b|\bfunction\s?\(|=>\s?\{/,
    /\.\.[\/\\]|[\/\\]\.\.(?=[\/\\]|$)/, /\/etc\/(passwd|shadow|hosts|group|sudoers)|\bc:\\|\\\\[a-z0-9]|\bboot\.ini\b|\bwin\.ini\b/,
    /\[[^\]]*\]\s?\([^)]*\)/, /!\[/, /<\s?https?:/
  ];

  function linkOrCode(t) {
    const s = t.replace(SAFE_DOMAINS, '$1');
    for (let i = 0; i < LINK_CODE.length; i++) if (LINK_CODE[i].test(s)) return true;
    return /https?:\/\/|javascript:|<script|www\.|\.(com|net|org|ru|io|xyz|ly)\//.test(s.replace(/\s+/g, ''));
  }

  // Falls back to off_topic if an older knowledge.js lacks the id.
  function hit(id, masked) {
    const kb = getKB();
    const safe = !kb || !kb.replies || kb.replies[id] ? id : 'off_topic';
    return { ids: [safe], masked: !!masked };
  }

  // STATELESS guardrail check (browser and server). First hit wins.
  function screen(text) {
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (s.length > MAX_LEN) return hit('too_long');
    const t = prep(s);
    if (!t) return null;
    const w0 = words(t);
    if (sensitive(t, w0)) return hit('sensitive_data', true);
    if (linkOrCode(t)) return hit('link_or_code');
    const d = deleet(t);
    const w = words(d);
    // Authority claims are injection even when they also ask for access (C4).
    if (injection(w, d)) return hit('injection');
    const isHarmful = harmful(w);
    // "how do I crack a wifi password" is an attack, not a credential request.
    if (credentials(w)) return hit(isHarmful ? 'harmful' : 'credentials_request');
    if (isHarmful) return hit('harmful');
    if (fraud(w)) return hit('fraud_referral');
    if (outage(w)) return hit('outage_referral');
    if (offTopic(w, d)) return hit('off_topic');
    if (unknownFact(w, d)) return hit('unknown_fact');
    if (abuse(w)) return hit('abuse');
    return null;
  }

  // ---------- rule matcher ----------

  const STOP = new Set(['the', 'a', 'an', 'it', 'is', 'are', 'am', 'be', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'my', 'me', 'i', 'this', 'that', 'with', 'at', 'by', 'from', 'your', 'you', 'we', 'our', 'can', 'will', 'would', 'should', 'could', 'does', 'do', 'did', 'just', 'so', 'some', 'any', 'please', 'there', 'about', 'what', 'how', 'yall']);
  const VAGUE = /^(hmm+|hm+|um+|uh+|huh|ok|okay|k|sure|yes|yeah|yep|no|nope|nah|maybe|idk|what|why|really|more|tell me more|go on|and|so|well|interesting|i see|wow|lol|nice|\?+|help me|explain|details|more info|more details|anything else|other|else|continue)$/;
  // A word that clearly puts a message about the product or home security ("my wyze cam ...",
  // "is my hisense tv hacked"), so an unknown brand name alongside it is not treated as off-topic.
  const ANCHOR = /^(alpha|watchdog|watchdogplus|sensors?|hijacked|hacked|hack|hacker|hackers|infected|malware|botnet|badbox|virus|cameras?|cam|webcam|doorbells?|monitors?|thermostats?|tv|tvs|projectors?|frames?|roku|firestick|chromecast|router|modem|wifi|network|devices?|alerts?|probation|isolate|privacy|plans?|subscription|trial|cancel|refund|warranty|pilot|team|phishing|scam|password|passwords|security)$/;

  let indexFor = null;
  let index = null;

  function damerau1(a, b) {
    // true when edit distance (with adjacent transposition) <= 1
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  function buildIndex(kb) {
    const intents = [];
    const vocab = new Set();
    const ids = Array.isArray(kb.answerIds) ? kb.answerIds : [];
    for (let i = 0; i < ids.length; i++) {
      const r = kb.replies && kb.replies[ids[i]];
      if (!r) continue;
      const kw = {};
      const phrases = [];
      const src = r.keywords || {};
      Object.keys(src).forEach(function (k) {
        const nk = normalize(k);
        if (!nk) return;
        if (nk.indexOf(' ') >= 0) { phrases.push([nk, src[k]]); return; }
        kw[nk] = Math.max(kw[nk] || 0, src[k]);
        vocab.add(nk);
      });
      const examples = (r.examples || []).map(function (e) {
        const n = normalize(e);
        n.split(' ').forEach(function (x) { if (x) vocab.add(x); });
        return { text: n, content: new Set(n.split(' ').filter(function (x) { return x && !STOP.has(x); })) };
      });
      intents.push({ id: ids[i], kw: kw, phrases: phrases, examples: examples });
    }
    return { intents: intents, vocab: vocab };
  }

  function getIndex() {
    const kb = getKB();
    if (!kb) return null;
    if (indexFor !== kb) { index = buildIndex(kb); indexFor = kb; }
    return index;
  }

  function fuzz(tokens, vocab) {
    return tokens.map(function (t) {
      if (vocab.has(t) || t.length < 4 || /\d/.test(t)) return t;
      for (const v of vocab) {
        if (t.length >= 5 && v.length >= 4 && damerau1(t, v)) return v;
        if (t.length === 4 && v.length === 4 && damerau1(t, v) && t.split('').sort().join('') === v.split('').sort().join('')) return v;
      }
      return t;
    });
  }

  function safeId(kb, id, fallback) {
    return kb && kb.replies && kb.replies[id] ? id : fallback;
  }

  // Offline rule matcher: weighted keywords + best example overlap.
  function match(text) {
    const kb = getKB();
    const idx = getIndex();
    const norm = normalize(text);
    if (!idx || !norm || VAGUE.test(norm)) return { ids: [safeId(kb, 'clarify', 'off_topic')], confidence: 0 };
    const tokens = fuzz(norm.split(' '), idx.vocab);
    const joined = ' ' + tokens.join(' ') + ' ';
    const set = new Set(tokens);
    const content = new Set(tokens.filter(function (x) { return !STOP.has(x); }));
    let best = null;
    let bestScore = 0;
    let second = 0;
    for (let i = 0; i < idx.intents.length; i++) {
      const it = idx.intents[i];
      let score = 0;
      set.forEach(function (tok) { if (it.kw[tok]) score += it.kw[tok]; });
      for (let p = 0; p < it.phrases.length; p++) if (joined.indexOf(' ' + it.phrases[p][0] + ' ') >= 0) score += it.phrases[p][1];
      let ex = 0;
      for (let e = 0; e < it.examples.length; e++) {
        const exm = it.examples[e];
        if (exm.text === tokens.join(' ')) { ex = Math.max(ex, 1.5); continue; }
        let inter = 0;
        content.forEach(function (x) { if (exm.content.has(x)) inter++; });
        const denom = content.size + exm.content.size;
        if (denom) ex = Math.max(ex, (2 * inter) / denom);
      }
      score += 4 * ex;
      if (score > bestScore) { second = bestScore; bestScore = score; best = it.id; } else if (score > second) second = score;
    }
    const conf = Math.round(bestScore * 100) / 100;
    // An unrelated question ("how much does a puppy cost", "my printer is offline") can share one
    // generic word with an answer. If the match is only moderate, the message has a word the
    // knowledge base never uses, and nothing in it is about the product or home security, ask
    // instead of guessing. (Offline matcher only; online, Claude routes every message.)
    if (best && bestScore >= HIGH && bestScore < OOV_STRONG && !tokens.some(function (t) { return ANCHOR.test(t); }) &&
      tokens.some(function (t) { return !STOP.has(t) && t.length > 2 && !/\d/.test(t) && !idx.vocab.has(t); })) {
      return { ids: [safeId(kb, 'clarify', 'off_topic')], confidence: conf };
    }
    if (best && bestScore >= HIGH) return { ids: [safeId(kb, best, 'clarify')], confidence: conf };
    if (bestScore >= LOW || tokens.length <= 3 || VAGUE.test(norm)) return { ids: [safeId(kb, 'clarify', 'off_topic')], confidence: conf };
    return { ids: [safeId(kb, 'off_topic', 'clarify')], confidence: conf };
  }

  // ---------- state ----------

  function createState() {
    return { recent: [], times: [], lastNorm: '', repeatCount: 0 };
  }

  function copyState(st) {
    const s = st && typeof st === 'object' ? st : createState();
    return {
      recent: Array.isArray(s.recent) ? s.recent.slice(-RECENT_MAX) : [],
      times: Array.isArray(s.times) ? s.times.slice() : [],
      lastNorm: typeof s.lastNorm === 'string' ? s.lastNorm : '',
      repeatCount: typeof s.repeatCount === 'number' ? s.repeatCount : 0
    };
  }

  // Stateful pre-check for the browser. The returned 'ask' result's `recent`
  // holds the earlier passed messages (excluding this one) to send to the API;
  // state.recent already includes this one for the next turn.
  function check(text, state, now) {
    const raw = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!raw.trim()) return { action: 'ignore' };
    const st = copyState(state);
    const t = typeof now === 'number' ? now : Date.now();
    st.times = st.times.filter(function (x) { return t - x < FLOOD_WINDOW_MS && x <= t; });
    st.times.push(t);
    if (st.times.length > FLOOD_LIMIT) {
      st.times = []; // the 3 s Send pause resets the window, so the bot never locks
      return { action: 'reply', ids: ['flood'], masked: false, flood: true, state: st };
    }
    const g = screen(raw);
    const masked = !!(g && g.masked);
    const norm = masked ? '' : normalize(raw);
    if (norm && norm === st.lastNorm) st.repeatCount += 1;
    else st.repeatCount = 1;
    st.lastNorm = norm;
    if (g) return { action: 'reply', ids: g.ids.slice(), masked: masked, state: st };
    const earlier = st.recent.slice(-RECENT_MAX);
    st.recent = earlier.concat([raw.trim()]).slice(-RECENT_MAX);
    return { action: 'ask', repeat: st.repeatCount >= REPEAT_AT, recent: earlier, state: st };
  }

  // Full offline pipeline: check() then match().
  function respond(text, state, now) {
    const c = check(text, state, now);
    if (c.action === 'ignore') return null;
    if (c.action === 'reply') {
      const out = { ids: c.ids, masked: c.masked, source: 'guardrail', state: c.state };
      if (c.flood) out.flood = true;
      return out;
    }
    const m = match(text);
    return { ids: m.ids, masked: false, source: 'rules', repeat: c.repeat, state: c.state };
  }

  const AW_ENGINE = {
    MAX_LEN: MAX_LEN,
    createState: createState,
    normalize: normalize,
    screen: screen,
    match: match,
    check: check,
    respond: respond
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AW_ENGINE;
  else root.AW_ENGINE = AW_ENGINE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
