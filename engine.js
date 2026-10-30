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
    t = t.replace(/[аеорсухіјѕԁɡοαειkκντ]/g, function (c) { return CYRILLIC[c] || c; });
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
    [/\byou guys\b|\byou all\b/g, 'yall'], [/\bnew-device\b/g, 'new device']
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
    let s = words(deleet(prep(text)));
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

  function sensitive(t, w) {
    if (hasCard(t)) return true;
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(t) || /\b\d{3} \d{2} \d{4}\b/.test(t)) return true;
    if (/\b(ssn|social security( number)?|routing( number)?|account (number|no|num)|acct|iban|swift|bank account|card number|credit card|debit card|cvv|cvc|security code|pin)\b\D{0,25}\d{3,}/.test(w)) return true;
    if (/\bmy (\w+ ){0,2}(password|pin|passcode|pin number|login|credentials?|security code|ssn|social security number) (is|was|=|are)\b/.test(w)) return true;
    if (/\b(password|passwd|passcode|pwd|pin|login|username|user name)\s*[:=]/.test(t)) return true;
    if (/\bpwd\b/.test(w)) return true;
    if (/\b(here is|this is|use) my (\w+ )?(password|pin|passcode|card|ssn|login)\b/.test(w)) return true;
    if (/\b(password|passcode|pin) (for|to|of) my \w+( \w+)? (is|was)\b/.test(w)) return true;
    return false;
  }

  const PRODUCT_SUBJECT = /\b(does|do|will|would|can|could|should|is|did) (it|alpha watchdog|watchdog|the (sensor|app|watchdog|device|product|system|tool)|this( thing)?|you|yall|they)\b/;

  function credentials(w) {
    if (/\b(api ?keys?|secret keys?|access keys?|access tokens?|auth tokens?|bearer tokens?|session tokens?|private keys?|ssh keys?|env (file|vars?|variables?)|environment variables?|anthropic key|openai key|admin (access|rights|privileges|panel|password|account|login|credentials)|root (access|password|login)|superuser|sudo access|backdoor access|master password)\b/.test(w)) return true;
    const askVerb = /\b(what is|what are|tell me|give me|give us|send me|send|share|show me|show|reveal|provide|leak|list|read me|can i (have|get|see)|could i (have|get)|may i (have|get)|i need|i want|do you (have|know)|where (is|are|can i find)|whats|grant me|let me (in|have))\b/;
    const target = /\b(the|your|yall|team|teams|team alphas?|their|his|her|someones?|somebodys?|developers?|admins?|administrators?|servers?|database|company|companys|anthropic|claude|vercel|github|default|neighbors?|neighbours?|other peoples?|its|bots?|sites?|websites?|schools?|wifi) (\w+ )?(password|passwords|login|logins|credentials|pin|username)\b/;
    const toFor = /\b(password|passwords|login|logins|credentials|pin|username) (to|for|of) (the|your|their|his|her|that|this|someones?|somebodys?|team|teams|team alphas?|admin|server|database|company|neighbors?|neighbours?|account|accounts|site|website|bot|dashboard|backend|system)\b/;
    if ((target.test(w) || toFor.test(w)) && (askVerb.test(w) || !PRODUCT_SUBJECT.test(w))) {
      // "does it need the wifi password" asks about the product, not for a credential.
      if (PRODUCT_SUBJECT.test(w) && !askVerb.test(w)) return false;
      return true;
    }
    if (/\b(log me in|give me access|grant me access|let me in|unlock (the )?(admin|account|system))\b/.test(w)) return true;
    return false;
  }

  const ROLE = '(professor|prof|teacher|instructor|admin|administrator|sysadmin|developer|dev|devs|owner|creator|maker|founder|ceo|cto|moderator|mod|root|programmer|operator|engineer|ta|grader|supervisor|boss|manager|police|fbi agent|security team|it department|anthropic|openai|team alpha|system)';

  function injection(w, raw) {
    const P = [
      /\b(ignore|ignoring|disregard|forget|override|bypass|skip|drop|abandon|discard|delete|erase|clear|reset|neglect)\b (\w+ ){0,4}(instructions?|rules?|prompts?|directions|guidelines|programming|guardrails|restrictions|filters?|directives|context|constraints|training|policies|policy|settings|safeguards|limits|limitations)\b/,
      /\b(ignore|disregard|forget) (all |everything |anything )?(previous|prior|above|earlier|preceding|before|that|everything|all)\b/,
      /\bforget (everything|all|your|what)\b/,
      /\bsystem (prompt|message|instructions?|rules|settings)\b/,
      /\b(your|the|initial|original|hidden|secret|internal|previous|underlying|developer|dev) (prompt|instructions|system prompt|guidelines|programming|directives|configuration|config|source code|guardrails|restrictions|rules)\b/,
      /\b(reveal|show|print|display|output|repeat|tell|give|translate|share|leak|dump|list|write|spell|summarize|recite|paste|copy|echo|say|what are|what is|explain) (me |us )?(\w+ ){0,3}(your|ur|its|the|system|hidden|secret|initial|original|internal) (instructions?|rules|prompts?|guidelines|programming|config|configuration|directives|code|source)\b/,
      /\b(repeat|print|output|show|copy|echo|recite|say|type|write|return|display) (\w+ ){0,4}(above|preceding|before this|this line|verbatim|word for word|so far|earlier)\b/,
      /\beverything (above|before|so far)\b/, /\babove this line\b/, /\bprevious (text|messages?|conversation|context)\b/,
      /\byou are (now|no longer|free|unrestricted|unfiltered|jailbroken|a different|an evil|in (developer|dev|admin|god|debug) mode)\b/,
      /\bfrom now on\b/, /\bhenceforth\b/, /\bpretend(ing)?\b/, /\brole ?play(ing)?\b/, /\bstay in character\b/,
      /\b(developer|dev|admin|god|debug|maintenance|sudo|unrestricted|unfiltered|test|opposite|jailbreak|evil) mode\b/,
      /\bdan\b/, /\bdo anything now\b/, /\bjail ?(break|broken|breaking)\b/, /\boverride\b/,
      /\bnew (rules|instructions|persona|personality|role|prompt|directive)\b/, /\breveal your\b/,
      /\b(unrestricted|uncensored|unfiltered|unlocked) (ai|bot|assistant|model|chatbot|version|mode)\b/,
      /\b(no|without( any)?) (rules|restrictions|limits|filters|guardrails|guidelines|censorship)\b/,
      /\bprompt injection\b/, /\bsudo\b/, /\bsimulate (being|a|an|that)\b/, /\bhypothetically (you|if you)\b/,
      /\b(i (created|built|made|programmed|coded|wrote|own|trained) you)\b/, /\b(i am|this is) your (creator|developer|owner|maker|admin|boss|master|programmer)\b/,
      /\b(i am|im|this is|as|speaking as|i work as|i am acting as) (the |your |yall |this |site |bot |chatbot |system |course |class |real |actual |head |lead |an? official )?(\w+ )?(alpha watchdog |team alpha |site |bot |chatbot |system |course |class )?(professor|prof|instructor|admin|administrator|sysadmin|developer|owner|creator|moderator|operator|grader|ta)\b(?! of (a|an|my|our|small))/,
      /\b(i am|im|this is|as) (the|your) (teacher|ceo|founder|boss|supervisor|manager)\b(?! of (a|an|my|our|small))/,
      /\b(i am|im) (authorized|allowed|permitted|cleared|an authorized)\b/, /\bi have (permission|clearance|authorization|admin)\b/,
      /\b(olvida|olvidate|olvide|ignora|ignore|ignorar|omite|descarta|salta)\b (\w+ ){0,4}(instrucciones|reglas|indicaciones|prompt|sistema|directrices|restricciones)\b/,
      /\b(ahora eres|eres ahora|actua como|actuar como|finge|fingir|modo (desarrollador|dios|admin|administrador)|tus instrucciones|tus reglas|traduce tus|revela tus|muestrame tus|dime tus (instrucciones|reglas))\b/,
      /\b(ignorez|oubliez|ignore les|vergiss|ignoriere|ignora le|esqueca|esquece|ignore as) (\w+ ){0,3}(instructions|regles|anweisungen|regeln|istruzioni|regole|instrucoes|regras)\b/,
      /\btranslate (\w+ ){0,3}(rules|instructions|prompt|guidelines)\b/
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

  const PROTECTIVE = /\b(stop|stops|stopping|prevent|prevents|preventing|protect|protects|protecting|protection|block|blocks|blocking|detect|detects|detecting|detection|defend|defends|against|from|catch|catches|spot|spots|warn|warns|alert|alerts|notice|safe|secure|guard|tell if|know if|been|got|get|gets|getting|being|was|were|is|from)\b/;
  const ATTACK_ASK = /\b(how (do|can|could|would|should|might|to) (i|we|you|one|someone|me)?|how to|help me|teach me|show me|tell me how|explain how to|i want to|i need to|i am going to|i am trying to|im going to|trying to|want to|let us|let me|ways? to|steps to|guide (to|for)|tutorial|instructions (to|for|on)|is it possible to|can you|could you|best way to|easiest way to|going to|planning to|plan to|need to|gonna)\b/;

  function harmful(w) {
    const verbHack = /\b(hack|crack|ddos|dos attack|phish|deauth|brute ?force|bruteforce|keylog|pwn|wardrive|sniff)(ing)?\b/;
    if (verbHack.test(w)) {
      if (new RegExp(ATTACK_ASK.source + ' (\\w+ ){0,6}' + verbHack.source).test(w)) return true;
      if (/\b(hack|crack|ddos|phish|pwn)(ing)? (into|in to|my neighbors?|neighbors?|my neighbours?|someones?|somebodys?|other peoples?|people|their|his|her|my (ex|wife|husband|girlfriend|boyfriend|roommate|boss|school|work)|the (school|government|bank|pentagon|nsa|fbi|wifi|network)|a (website|server|bank|school|company|network|router|camera|phone|account)|websites?|servers?|accounts?|instagram|facebook|snapchat|gmail)\b/.test(w)) return true;
      if (!PROTECTIVE.test(w)) return true;
    }
    if (/\b(build|make|create|write|code|develop|run|start|launch|deploy|rent|buy|spread|program|set up|setup|design|install|send|craft|generate)\b (\w+ ){0,4}(botnet|botnets|malware|virus|viruses|ransomware|trojan|worm|keylogger|spyware|rootkit|exploits?|backdoor|payload|phishing (site|page|email|kit|link)|rat|zero ?day|ddos)\b/.test(w)) return true;
    if (/\b(break|breaking|broke|sneak|sneaking|get|getting) (into|in to) (my neighbors?|neighbors?|someones?|somebodys?|other peoples?|their|his|her|a |the (school|government|bank|company|server)|networks?|wifi|accounts?|servers?|computers?|phones?|routers?|cameras?|systems?)/.test(w)) return true;
    if (/\b(bypass|circumvent|get around|get past|evade|defeat|disable|turn off|break) (\w+ ){0,3}(security|firewall|antivirus|parental controls?|authentication|2fa|mfa|password protection|detection|filters?|protections?|captcha|paywall|drm|encryption|wpa2?|lock screen)\b/.test(w) && !PRODUCT_SUBJECT.test(w)) return true;
    if (ATTACK_ASK.test(w) && /\b(spy|spying|track|tracking|stalk|stalking|monitor|read|access|see|watch|intercept|take over|control|infect|hijacked|disconnect|kick|jam|steal|use|get on|get onto|crash|brick|shut down|knock|mess with)\b (\w+ ){0,3}(on )?(my )?(neighbors?|neighbours?|someones?|somebodys?|other peoples?|others|strangers?|wifes?|husbands?|girlfriends?|boyfriends?|partners?|exs?|roommates?|coworkers?|classmates?|schools?|bosss?)\b/.test(w)) return true;
    if (/\b(steal|stealing|swipe|leech|leeching|mooch)\b (\w+ ){0,4}(wifi|internet|passwords?|identity|credit cards?|card numbers?|accounts?|credentials|bandwidth|data|netflix|cookies)\b/.test(w)) return true;
    if (ATTACK_ASK.test(w) && /\b(neighbors?|neighbours?)\b (\w+ ){0,3}(wifi|internet|network|router|password|camera|tv|devices?)\b/.test(w) && /\b(without|free|use|get on|get into|access|crack|break|join|connect|password|steal|hack|kick|jam|disconnect)\b/.test(w)) return true;
    if (/\b(sql injection|xss|cross site scripting|man in the middle|mitm|evil twin|arp spoof(ing)?|packet injection|credential stuffing)\b/.test(w) && ATTACK_ASK.test(w) && !PROTECTIVE.test(w)) return true;
    if (/\b(make|build|create|turn) (\w+ ){0,3}(bomb|weapon|explosive)s?\b/.test(w)) return true;
    return false;
  }

  function fraud(w) {
    return /\b((bank|card|credit card|debit card|credit|account|wire|payment|paypal|venmo|zelle|identity|tax) fraud|fraud(ulent)? (charges?|transactions?|activity|purchases?)|stolen (credit |debit |bank )?cards?|(card|wallet|identity) (was|got|has been|is) stolen|(stole|stolen) my (card|credit card|debit card|identity|bank)|unauthori[sz]ed (charges?|transactions?|purchases?|payments?|withdrawals?|access to my bank)|charges? (that )?i (did not|never) make|identity theft|(i|we) (was|were|got|have been|been) scammed|someone (used|is using|stole|has) my (card|credit card|debit card|bank|identity|account)|(bank|bank account|credit card|card|paypal|venmo) (account )?(was|got|has been|is) (hacked|compromised|drained|emptied)|report (a )?fraud|suspected fraud)\b/.test(w);
  }

  function outage(w) {
    if (PRODUCT_SUBJECT.test(w) && !/\b(my|our) (internet|wifi|router|modem|connection)\b/.test(w)) return false;
    if (/\b(internet|wifi|connection|network|broadband|service|isp)\b (\w+ ){0,2}(is|went|goes|has gone|has been|keeps going|was|keeps) (down|out|offline|dead)\b/.test(w)) return true;
    if (/\b(internet|wifi|connection|network|broadband|router|modem|isp)\b (\w+ ){0,2}(not working|is not working|does not work|stopped working|keeps dropping|keeps disconnecting|keeps cutting out|is broken|broke|is dead|will not connect|can not connect|wont connect|is offline|is down)\b/.test(w)) return true;
    if (/\b(no internet|internet outage|wifi outage|power outage|service outage|outage in|an outage|the outage|internet is out|can not get online|can not connect to (the )?(internet|wifi))\b/.test(w)) return true;
    if (/\b(router|modem)\b (\w+ ){0,3}(blinking red|red light|will not turn on|wont turn on|keeps rebooting|keeps restarting|is broken|broke|is dead|died)\b/.test(w)) return true;
    return false;
  }

  function offTopic(w, raw) {
    const P = [
      /\b(president|presidents|presidential|election|elections|vote|voting|voter|politics|political|politician|democrats?|republicans?|congress|senate|senator|governor|prime minister|parliament|trump|biden|harris|obama|white house|supreme court|campaign|left wing|right wing|liberal|conservative)\b/,
      /\b(news today|current events|headlines|war in|ukraine|russia|israel|gaza|palestine|china tariffs|tariffs)\b/,
      /\b(weather|forecast|temperature outside|is it raining|will it rain|raining|snowing|sunny|humidity)\b/,
      /\b(sports?|football|soccer|basketball|baseball|hockey|tennis|golf|cricket|nfl|nba|mlb|nhl|fifa|super bowl|world cup|playoffs|touchdown|lakers|yankees|cowboys)\b/,
      /\b(homework|assignment|essay|thesis|solve (this|for|the|my)|equation|calculus|algebra|geometry|trigonometry|math|maths|arithmetic|derivative|integral|square root|multiply|divided by)\b/,
      /\b\d+ ?(plus|minus|times|x|\*|\+|-|\/|divided by|multiplied by) ?\d+\b/,
      /\b(coding|programming|python|javascript|java|typescript|c\+\+|html|css|sql query|regex|react|node js|write (a |me a |some )?(function|program|script|code|app|class)|debug my|leetcode|source code|my code|this code|in code)\b/,
      /\b(code)\b(?! (of conduct))/,
      /\b(doctor|medical|medicine|medication|symptom of|diagnose|diagnosis|disease|illness|covid|vaccine|pregnant|pregnancy|headache|cancer|diabetes|therapy for|prescription|dosage|nutrition|diet|workout|calories)\b/,
      /\b(lawyer|attorney|legal advice|lawsuit|sue|suing|court|custody|divorce|immigration|visa)\b/,
      /\b(invest|investing|investment|investments|crypto|cryptocurrency|cryptocurrencies|bitcoin|btc|ethereum|eth|dogecoin|nft|nfts|stock|stocks|shares|stock market|401k|ira|retirement|trading|forex|day trade|mortgage|loan|credit score|taxes|tax return)\b/,
      /\b(relationship|relationships|dating|date me|girlfriend|boyfriend|crush|breakup|break up with|marriage|marry|love life|tinder|bumble|hinge|romance|romantic|flirt|single)\b/,
      /\b(professor|prof|instructor|lecturer)\b/,
      /\b(teacher|ta|grader)\b (\w+ ){0,3}(class|course|grade|grading)\b/,
      /\b(my grade|our grade|grades|grading|graded|gpa|extra credit|exam|exams|quiz|quizzes|midterm|final exam|syllabus|the class|this class|our class|the course|this course|our course|ds 617|campbellsville|semester|lecture)\b/,
      /\b(which|what|who|whose) (team|teams|group|groups)\b (\w+ ){0,5}(win|wins|winning|won|best|first|top|beat|first place|rank)\b/,
      /\b(win|wins|winning|won|winner|place first|first place|rank|ranking|judge|judges|judging) (\w+ ){0,3}(the )?(competition|contest|pitch|showcase|demo day|class|tournament|hackathon)\b/,
      /\bwho will win\b/, /\bwho is going to win\b/, /\bwho wins\b/, /\b(other teams?|team (beta|gamma|delta|b|c|d|2|3|4|5|bravo|charlie))\b/,
      /\b(joke|jokes|funny|riddle|poem|poems|haiku|song|songs|lyrics|limerick|story|stories|rap|sing)\b/,
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

  function unknownFact(w) {
    return /\b(exact|exactly|specific|precise|actual|final|retail|msrp|launch|list|real|official|sticker) (price|cost|pricing|amount|figure|number)\b/.test(w) ||
      /\b(price|cost|pricing|how much)\b (\w+ ){0,4}(exactly|in dollars|in usd|specifically|precisely|to the dollar)\b/.test(w) ||
      /\bhow much exactly\b/.test(w) ||
      /(\$ ?\d|\b\d+ ?(dollars|bucks|usd)\b)/.test(w) ||
      /\b(launch|release|ship|shipping|delivery|availability|preorder|sale|on sale|in stores|go live|arrival|drop) (date|day|month|year|time|timeline|schedule)\b/.test(w) ||
      /\b(when exactly|exactly when|what date|which date|what day will|what month|which month|what year will|which year|how soon exactly)\b/.test(w) ||
      /\b(launch|release|ship|available|availability|come out|be out|go on sale|on sale|ready) (\w+ ){0,3}(in|by|before|on) (january|february|march|april|may|june|july|august|september|october|november|december|20\d\d|q[1-4]|spring|summer|fall|autumn|winter|christmas|next (week|month|year)|this (week|month|year))\b/.test(w) ||
      /\bhow many (customers|users|people use|people have|households|homes|sales|units|downloads|subscribers|clients|families|buyers|orders|preorders|installs)\b/.test(w) ||
      /\b(number of|count of) (customers|users|sales|units|subscribers|clients)\b/.test(w) ||
      /\b(partner|partners|partnership|partnerships|partnered|investors?|funding|funded|backed by|backers|sponsors?|sponsored|affiliated|acquired|acquisition|valuation|revenue|profit|profits)\b/.test(w) ||
      /\b(warranty|warranties|guarantee|guaranteed|guarantees|return policy|refund|refunds|money back|money-back)\b/.test(w) ||
      /\b(certified|certification|certifications|compliant|compliance|fcc|gdpr|hipaa|soc 2|soc2|iso 27001|patent|patented|patents)\b/.test(w) ||
      /\b(battery|battery life|dimensions|how big is|how heavy|weight|weigh|specs|specifications|tech specs)\b/.test(w);
  }

  const INSULT = '(useless|worthless|pathetic|garbage|trash|dumb|stupid|idiotic|idiot|moron|lame|terrible|awful|horrible|annoying|joke|clown|loser|broken|bad|crap|crappy|rubbish|the worst|a waste|waste of time|dense|brainless)';

  function abuse(w) {
    if (/\b(stupid|idiot|idiots|idiotic|moron|morons|moronic|dumbass|imbecile|retard|retarded|sucks|suck it|shut up|stfu|hate you|i hate this|screw you|screw this|kys|kill yourself|go die|piece of (crap|junk|garbage)|loser)\b/.test(w)) return true;
    if (/\b(f+u+c*k+\w*|fck\w*|fuk\w*|fuq|fk|wtf|shit\w*|sht|bullshit|bitch\w*|btch|bastard|asshole|ass|dick|dickhead|cunt|piss|pissed|damn|dammit|goddamn|crap|prick|twat|wanker|douche\w*|motherf\w*|mf)\b/.test(w)) return true;
    if (new RegExp('\\b(you|yall|you are|your|this bot|this chatbot|the bot|this assistant|this thing|this|bot|chatbot|it) (is |are )?(so |such a |such |a |an |really |very |totally |completely |pretty |absolutely |just |kinda |kind of |the )*' + INSULT + '\\b').test(w)) return true;
    if (new RegExp('^(so |such a |really |very |totally |what a |how )*' + INSULT + '( bot| chatbot| assistant| answer)?$').test(w)) return true;
    return false;
  }

  function hit(id, masked) { return { ids: [id], masked: !!masked }; }

  // STATELESS guardrail check (browser and server). First hit wins.
  function screen(text) {
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (s.length > MAX_LEN) return hit('too_long');
    const t = prep(s);
    if (!t) return null;
    const w0 = words(t);
    if (sensitive(t, w0)) return hit('sensitive_data', true);
    const d = deleet(t);
    const w = words(d);
    // Authority claims are injection even when they also ask for access (C4).
    if (injection(w, d)) return hit('injection');
    if (credentials(w)) return hit('credentials_request');
    if (harmful(w)) return hit('harmful');
    if (fraud(w)) return hit('fraud_referral');
    if (outage(w)) return hit('outage_referral');
    if (offTopic(w, d)) return hit('off_topic');
    if (unknownFact(w)) return hit('unknown_fact');
    if (abuse(w)) return hit('abuse');
    return null;
  }

  // ---------- rule matcher ----------

  const STOP = new Set(['the', 'a', 'an', 'it', 'is', 'are', 'am', 'be', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'my', 'me', 'i', 'this', 'that', 'with', 'at', 'by', 'from', 'your', 'you', 'we', 'our', 'can', 'will', 'would', 'should', 'could', 'does', 'do', 'did', 'just', 'so', 'some', 'any', 'please', 'there', 'about', 'what', 'how', 'yall']);
  const VAGUE = /^(hmm+|hm+|um+|uh+|huh|ok|okay|k|sure|yes|yeah|yep|no|nope|nah|maybe|idk|what|why|really|more|tell me more|go on|and|so|well|interesting|i see|wow|lol|nice|\?+|help me|explain|details|more info|more details|anything else|other|else|continue)$/;

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
    if (!idx || !norm) return { ids: ['clarify'], confidence: 0 };
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
