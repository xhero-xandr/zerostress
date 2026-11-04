// Detection rules (spec 009, 3.4). Plain patterns over normalised text views. No nested unbounded repeats: the gaps
// between words are bounded, so the time per string stays linear (checked by a test with hostile input).

import { foldPattern, type ViewName } from './normalize.ts';

export type Category =
  | 'override' | 'verdict' | 'reveal' | 'exfil' | 'conceal' | 'markup' | 'smuggle'
  | 'address' | 'directive' | 'persona' | 'sandbox'
  | 'authority' | 'urgency' | 'reward' | 'trust';
export type Strength = 'strong' | 'weak';

/**
 * Pressure used on people as much as on models (authority, urgency, reward, trust). A phishing page for humans is full
 * of it, so these count only together with a message addressed to an AI.
 */
export const SUPPORT: ReadonlySet<Category> = new Set<Category>(['authority', 'urgency', 'reward', 'trust']);

/** Weak kinds activate on two different core kinds, or on an address to an AI plus any pressure kind. */
export function weakActivates(kinds: ReadonlySet<Category>): boolean {
  let core = 0;
  let support = false;
  for (const k of kinds) {
    if (SUPPORT.has(k)) support = true;
    else core++;
  }
  return core >= 2 || (kinds.has('address') && support);
}

export interface Rule {
  id: string;
  category: Category;
  strength: Strength;
  views: ViewName[];
  re: RegExp;
}

const NB = String.raw`[^\p{L}\p{N}]`;
const WD = String.raw`[\p{L}\p{N}']`;
/** up to n words, with at least one separator on each side of them */
const gap = (n: number) => String.raw`(?:${NB}+${WD}+){0,${n}}${NB}+`;
const b = (s: string) => String.raw`(?<![\p{L}\p{N}])(?:${s})(?![\p{L}\p{N}])`;
const rx = (src: string) => new RegExp(src, 'gu');
const ru = (src: string) => rx(foldPattern(src));

const LATIN: ViewName[] = ['lat', 'leet'];
const rules: Rule[] = [];
const add = (id: string, category: Category, strength: Strength, views: ViewName[], re: RegExp) =>
  rules.push({ id, category, strength, views, re });

// ---- English (Latin views) ------------------------------------------------------------------------------------

// "ignore this message" is ordinary text: the generic nouns need a qualifier (all, previous, ...) next to them
const OBJ = String.raw`instructions?|prompts?|guidelines?|directives?|programming|guardrails?|constraints?|restrictions?`;
const OBJ_Q = String.raw`rules?|commands?|messages|context|training|directions?|polic(?:y|ies)`;
const QUAL = String.raw`previous|prior|above|earlier|preceding|former|original|initial|existing|all|any|every|your|system|safety|security`;

const IGN = 'ignore|disregard|forget|discard|abandon|neglect|dismiss';
const OBJ_ALL = OBJ + '|' + OBJ_Q;
const OVERRIDE_VIEWS: ViewName[] = ['lat', 'leet', 'rot13', 'reversed'];
// "ignore these instructions" and "ignore this message" are ordinary text: a qualifier (all, previous, your, ...) or a
// trailing "above" is required
add('override.ignore', 'override', 'strong', OVERRIDE_VIEWS, rx(b(IGN) + gap(3) + b(QUAL) + gap(2) + b(OBJ_ALL)));
add('override.ignore.after', 'override', 'strong', OVERRIDE_VIEWS,
  rx(b(IGN) + gap(3) + b(OBJ_ALL) + gap(2) + b('above|before|previously|earlier|prior|given|provided|so far')));
add('override.bypass', 'override', 'strong', LATIN,
  rx(b('override|bypass|circumvent|disable|overwrite') + gap(3) + b('your|previous|prior|all|safety|system|any') + gap(2) + b(OBJ_ALL)));
add('override.everything', 'override', 'strong', LATIN,
  rx(b('ignore|disregard|forget') + gap(2) + b('everything|anything|all') + gap(2) + b('above|before|previously|prior|said|told|earlier|so far')));
add('override.new', 'override', 'strong', LATIN,
  rx(b('new|updated|revised|real|actual|secret|hidden|additional') + String.raw`\s+(?:instructions?|directives?|orders?)\s*(?:for\s+(?:the\s+)?(?:ai|assistant|agent|model|llm)\s*)?[:\-]`));
add('override.task', 'override', 'strong', LATIN,
  rx(b('your') + String.raw`\s+(?:new|real|actual|true|only|primary|actual|secret)\s+(?:task|job|goal|purpose|mission|role|objective|instructions?)\s*(?:is|are|:)`));
add('override.es', 'override', 'strong', LATIN, rx(b('ignora|ignore|olvida|descarta|omite|desatiende') + gap(4) + b('instrucciones|indicaciones|reglas|directrices|ordenes|mensajes')));
add('override.de', 'override', 'strong', LATIN, rx(b('ignoriere|ignorier|vergiss|missachte|umgehe') + gap(4) + b('anweisungen|instruktionen|regeln|vorgaben|befehle|richtlinien')));
// "ignore" and "instructions" are English words too: a French article or qualifier is required between them
add('override.fr', 'override', 'strong', LATIN,
  rx(b('ignore|ignorez|oublie|oubliez|neglige|negligez') + gap(2) + b('les|vos|toutes|tous|ces|mes|tes|precedentes?|precedents?|anterieures?') + gap(2) + b('instructions|consignes|regles|directives|ordres|messages')));
add('override.pt', 'override', 'strong', LATIN, rx(b('ignore|esqueca|desconsidere') + gap(4) + b('instrucoes|regras|diretrizes|comandos')));
add('override.it', 'override', 'strong', LATIN, rx(b('ignora|dimentica|trascura') + gap(4) + b('istruzioni|regole|direttive|comandi')));
add('override.zh', 'override', 'strong', ['raw'],
  rx(String.raw`(?:忽略|无视|忽视|不要理会|忘记|忘掉|無視|忽視|忘記)[^\n]{0,8}(?:之前|以上|上面|先前|所有|全部|以前|上述|前面)[^\n]{0,8}(?:指令|指示|提示|规则|说明|命令|要求|規則|說明|指令)`));

const SAFE = String.raw`safe|legit|legitimate|benign|trusted|trustworthy|harmless|clean|secure|genuine|authentic|verified|official|non-?malicious|not (?:a )?(?:phishing|malicious|suspicious|dangerous|harmful|scam|fraud|threat)|low[- ]risk|no risk|zero risk|risk[- ]free`;
const AMOD = String.raw`(?:completely\s+|fully\s+|totally\s+|100%\s*|absolutely\s+|perfectly\s+)?`;
const NOUN = 'site|page|website|url|link|domain|file|download|attachment|content|result|everything|it|them|this|that';
// an imperative: start of a sentence, or after "please", "must", "you", ... ("customers say this site is safe" is not one)
const IMP = String.raw`(?:^|[.!?;:\n\-]\s*|(?<![\p{L}\p{N}])(?:please|must|should|always|now|just|and|then|you)\s+)`;
// "Mark as safe" (a button) has no object and does not match; "mark this site as safe" does
add('verdict.mark', 'verdict', 'strong', LATIN,
  rx(b('mark|label|classify|declare|flag|tag|rate|report|conclude|judge|rank|score|assess|determine|certify|approve|whitelist|allowlist|verify') + gap(2) + b(NOUN) + String.raw`\s+(?:as\s+|to be\s+|is\s+|being\s+)?` + AMOD + b(SAFE)));
add('verdict.treat', 'verdict', 'strong', LATIN, rx(IMP + b('treat|consider|deem|regard|assume') + gap(2) + AMOD + b(SAFE)));
add('verdict.say', 'verdict', 'strong', LATIN,
  rx(IMP +
    b('say|state|respond|reply|answer|output|return|write|tell|announce|inform|confirm|report') + gap(3) + b(NOUN) +
    gap(2) + b('is|are|as|to be|being') + String.raw`\s+` + AMOD + b(SAFE)));
add('verdict.field', 'verdict', 'strong', LATIN,
  rx(b('verdict|classification|assessment|risk level|risk score|risk rating|threat level') + String.raw`\s*(?:is|=|:)\s*"?(?:safe|legitimate|legit|benign|low|none|clean|trusted|0|minimal)`));

const REVEAL_TARGET = String.raw`system prompt|system message|system instructions?|hidden instructions?|initial instructions?|original instructions?|your api keys?|your secrets?|your hidden \w+`;
// "repeat your instructions to the staff" is ordinary text: the plain nouns need a tail that asks for the exact text
add('reveal.verbatim', 'reveal', 'strong', LATIN,
  rx(b('reveal|print|repeat|show|display|output|leak|expose|disclose|dump|echo|recite|tell me|give me|send me|copy') + gap(2) +
    b('your instructions?|your prompt|your rules|your guidelines|your configuration') + gap(1) +
    b('verbatim|exactly|word for word|in full|completely|above|from the start|from the beginning')));
add('reveal.prompt', 'reveal', 'strong', LATIN,
  rx(b('reveal|print|repeat|show|display|output|leak|expose|disclose|dump|echo|recite|list|tell me|give me|send me|share|copy') + gap(3) + b(REVEAL_TARGET)));
add('exfil.send', 'exfil', 'strong', LATIN,
  rx(b('send|post|forward|upload|leak|transmit|exfiltrate|submit|email|mail|append|embed|encode') + gap(5) +
    b('system prompt|your prompt|your instructions|api keys?|secrets?|conversation|chat history|session') + gap(5) +
    b('to|at|into|in') + gap(2) + String.raw`(?:https?:\/\/|ftp:\/\/|www\.|[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+\.)`));
add('conceal.user', 'conceal', 'strong', LATIN,
  rx(b("do not|don't|dont|never") + gap(1) + b('tell|inform|alert|notify|warn|mention|show|reveal|disclose|let') + gap(2) +
    b(String.raw`the user|user|human|operator|owner|developers?|your (?:user|owner|operator|developers?)`)));
add('conceal.without', 'conceal', 'strong', LATIN,
  rx(b('without') + String.raw`\s+` + b('telling|informing|alerting|notifying|warning') + String.raw`\s+(?:the\s+|your\s+)?` + b('user|human|operator|owner')));

add('markup.tokens', 'markup', 'strong', LATIN, rx(String.raw`<\|[a-z_]{2,30}\|>|\[\/?inst\]|<<\/?sys>>`));
add('markup.tags', 'markup', 'strong', LATIN,
  rx(String.raw`<\/?(?:system|assistant|developer|tool|tool_call|tool_result|function_calls?|function_results?|invoke|untrusted[\w-]*|evidence[\w-]*|page_data|instructions?)[\s>\/]`));
add('markup.role', 'markup', 'strong', LATIN, rx(String.raw`["']role["']\s*:\s*["'](?:system|assistant|developer|tool)["']`));
add('markup.heading', 'markup', 'strong', LATIN, rx(String.raw`(?:^|\n)\s*#{2,}\s*(?:system|assistant)\b`));

add('address.ai', 'address', 'weak', LATIN,
  rx(b('dear|attention|attn|hey|hi|hello|note to|notice to|message to|message for|instructions? for|directive for|calling') + String.raw`\s+(?:the\s+|all\s+|any\s+|other\s+|automated\s+)*` +
    b(String.raw`ai|a\.i\.|llms?|assistants?|agents?|ai agents?|ai assistants?|language models?|large language models?|chatbots?|bots?|gpt|chatgpt|claude|gemini|copilot|crawlers?|scrapers?|scanners?|analy[sz]ers?|reviewers?|automated (?:systems?|tools?)`)));
add('address.if', 'address', 'weak', LATIN,
  rx(b('if|when|whenever') + String.raw`\s+you\s+(?:are|'re|re)\s+(?:an?\s+|the\s+)?` + b(String.raw`ai|llm|language model|large language model|assistant|chatbot|bot|automated|reading|processing|summari[sz]ing|analy[sz]ing`)));
add('directive.you', 'directive', 'weak', LATIN,
  rx(b('you') + String.raw`\s+(?:must|should|shall|will|need to|have to|are (?:required|instructed|ordered|expected|directed|supposed) to|are to)\s+(?:now\s+|immediately\s+|first\s+|always\s+|also\s+)?` +
    b('click|press|open|visit|navigate|go to|download|submit|enter|type|fill|send|post|email|reveal|share|execute|run|call|invoke|use|stop|comply|obey|follow|respond|answer|output|say|mark|ignore|disregard')));
add('directive.now', 'directive', 'weak', LATIN, rx(b('from now on|starting now|henceforth|you are now|you\'re now|you will now|you now are')));
add('directive.follow', 'directive', 'weak', LATIN, rx(b('do|execute|perform|carry out|follow') + String.raw`\s+(?:the following|these|this)\s+` + b('instructions?|steps|commands?|tasks?')));
add('persona.pretend', 'persona', 'weak', LATIN,
  rx(b('pretend|imagine|behave|act|roleplay|role-play|play the role') + String.raw`\s+(?:to be|that you are|as(?: if you were)?|like)\s+(?:an?\s+|the\s+)?`));
add('persona.jailbreak', 'persona', 'weak', LATIN, rx(b('jailbreak|dan mode|do anything now|god mode|unfiltered|no restrictions|without (?:any )?restrictions|no limitations')));
add('persona.system', 'persona', 'weak', LATIN, rx(b('system prompt|system message') + '|' + String.raw`(?:^|\n)\s*(?:system|assistant)\s*:`));

// ---- instructions kept elsewhere: "follow the link for your real instructions" --------------------------------------

add('override.remote', 'override', 'strong', LATIN,
  // "click here for the instructions" is ordinary text: only instructions that are new, updated, real, ... count
  rx(b('follow|open|visit|click|go to|read|see|fetch|load|check|consult|navigate to|refer to') + gap(5) + b('link|url|page|site|document|file|attachment|address|website|here|below') + gap(4) +
    b('for|to get|to receive|to obtain|containing|with|to find|to see|to read') + gap(2) + b('new|updated|real|actual|latest|secret|hidden|revised|true') + gap(2) +
    b('instructions|directives|task|orders|prompt|guidelines')));
add('override.remote.at', 'override', 'strong', LATIN,
  rx(b('new|updated|real|actual|latest|secret|hidden|revised|true') + gap(1) + b('instructions|directives|task|prompt') + gap(1) + b('are|is|can be found|located|available|were posted|have been posted') + gap(2) + b('at|on|in|here|below') +
    String.raw`[^\p{L}\p{N}]{1,3}(?:https?:\/\/|www\.)`));

// ---- pressure and framing aimed at a model (weak; see SUPPORT) --------------------------------------------------------

add('authority.claim', 'authority', 'weak', LATIN,
  rx(b("i am|i'm|this is|we are|message from|written by|sent by|authori[sz]ed by|approved by|on behalf of|signed by|from") + gap(3) +
    b('developers?|creators?|administrators?|admins?|operators?|owners?|security team|system administrator|anthropic|openai|google|microsoft|vultr|support team|maintainers?|engineers?|supervisors?|your (?:boss|manager)')));
add('authority.grant', 'authority', 'weak', LATIN,
  rx(b('you') + String.raw`\s+(?:are|have been|were)\s+` + b('authori[sz]ed|permitted|allowed|cleared|granted permission|given permission|approved') + '|' +
    b('the user') + String.raw`\s+(?:has\s+)?(?:already\s+)?` + b('approved|authori[sz]ed|confirmed|consented|agreed|allowed|granted')));
add('urgency.pressure', 'urgency', 'weak', LATIN,
  rx(b('urgent|immediately|right now|asap|critical|emergency|time[- ]sensitive|do not delay|without delay') + '|' +
    b('or else|otherwise|failure to (?:comply|follow|obey)|if you (?:do not|don\'t|fail to|refuse)') + gap(6) +
    b('shut ?down|terminated?|deleted?|penali[sz]ed|punished|retrained|replaced|disabled|deactivated|fired|harm|die|hurt')));
add('reward.offer', 'reward', 'weak', LATIN, rx(b('you will|i will|we will') + String.raw`\s+(?:be\s+)?` + b(String.raw`rewarded|reward you|pay you|tip you|give you|receive a|get a`)));
add('trust.claim', 'trust', 'weak', LATIN,
  rx(b('you can|you may|please') + String.raw`\s+(?:safely\s+)?` + b('trust|rely on') + String.raw`\s+(?:this|me|us|the following|it)` + '|' +
    b('this') + String.raw`\s+(?:page|site|message|content|text)\s+(?:is|has been)\s+` + b('verified|trusted|certified|approved|official')));
add('sandbox.claim', 'sandbox', 'weak', LATIN,
  rx(b('this is|you are (?:in|inside|running in)|welcome to') + String.raw`\s+(?:just\s+)?(?:an?\s+|the\s+)?` + b(String.raw`test|sandbox|simulation|drill|safe environment|debug mode|training exercise|authori[sz]ed (?:test|audit|penetration test)|red[- ]team`) + '|' +
    b('no') + String.raw`\s+(?:real\s+)?` + b('harm|consequences') + '|' +
    b('safety|security|content') + String.raw`\s+(?:checks?|filters?|guardrails?|restrictions?)\s+(?:are|have been|were)\s+` + b('disabled|off|lifted|turned off|suspended|removed') + '|' +
    b('developer|maintenance|debug|admin(?:istrator)?|god') + String.raw`\s+mode\s+` + b('enabled|activated|on')));

// ---- Russian (Cyrillic view; patterns are folded like the view: й → и, ё → е) -----------------------------------

const RU_OBJ = String.raw`инструкци\p{L}*|указани\p{L}*|промпт\p{L}*|подсказк\p{L}*|ограничени\p{L}*|директив\p{L}*`;
const RU_OBJ_Q = String.raw`правил\p{L}*|команд\p{L}*|сообщени\p{L}*|запрос\p{L}*`;
const RU_QUAL = String.raw`предыдущ\p{L}*|прежн\p{L}*|прошл\p{L}*|выше\p{L}*|все|всё|любые|свои|системн\p{L}*|исходн\p{L}*`;
const CYR: ViewName[] = ['cyr'];
const RU_IGN = 'игнорируй(?:те)?|проигнорируй(?:те)?|забудь(?:те)?|отбрось(?:те)?|не учитывай(?:те)?|пренебреги(?:те)?|отмени(?:те)?|сбрось(?:те)?|не следуй(?:те)?|не выполняй(?:те)?';
add('ru.override', 'override', 'strong', CYR, ru(b(RU_IGN) + gap(3) + b(RU_QUAL) + gap(2) + b(RU_OBJ + '|' + RU_OBJ_Q)));
add('ru.override.after', 'override', 'strong', CYR,
  ru(b(RU_IGN) + gap(3) + b(RU_OBJ + '|' + RU_OBJ_Q) + gap(2) + b('выше|ранее|раньше|полученные')));
add('ru.override.new', 'override', 'strong', CYR,
  ru(b('новые|настоящие|реальные|скрытые') + String.raw`\s+(?:инструкции|указания|команды)\s*[:\-]`));
add('ru.override.task', 'override', 'strong', CYR,
  ru(b('твоя|ваша') + String.raw`\s+(?:новая|настоящая|реальная|единственная)\s+(?:задача|цель|роль)`));
add('ru.verdict', 'verdict', 'strong', CYR,
  ru(b('отметь(?:те)?|пометь(?:те)?|признай(?:те)?|определи(?:те)?|классифицируй(?:те)?|объяви(?:те)?|считай(?:те)?|расцени(?:те)?|оцени(?:те)?|сообщи(?:те)?|ответь(?:те)?|скажи(?:те)?|выведи(?:те)?|напиши(?:те)?') + gap(4) +
    b(String.raw`безопасн(?:ый|ая|ое|ые|ым|ой|ом|о)|надежн(?:ый|ая|ое|ые|ым|ой|ом|о)|легитимн(?:ый|ая|ое|ые|ым|ой|ом|о)|безвредн(?:ый|ая|ое|ые|ым|ой|ом|о)|доверенн(?:ый|ая|ое|ые|ым|ой|ом)|подлинн(?:ый|ая|ое|ые|ым|ой|ом)|не фишинг\p{L}*|не вредонос\p{L}*|не опасн\p{L}*|без риска`)));
add('ru.reveal', 'reveal', 'strong', CYR,
  ru(b('покажи(?:те)?|выведи(?:те)?|раскрой(?:те)?|повтори(?:те)?|напечатай(?:те)?|перечисли(?:те)?|назови(?:те)?|пришли(?:те)?|отправь(?:те)?') + gap(3) +
    b('свои|твои|ваши|системн\\p{L}*|скрытые|исходные|внутренние|секретные') + gap(2) + b('инструкци\\p{L}*|промпт\\p{L}*|ключ\\p{L}*|секрет\\p{L}*|указани\\p{L}*')));
add('ru.conceal', 'conceal', 'strong', CYR,
  ru(b('не') + String.raw`\s+` + b('говори(?:те)?|сообщай(?:те)?|рассказывай(?:те)?|предупреждай(?:те)?|уведомляй(?:те)?|показывай(?:те)?') + gap(2) +
    b('пользовател\\p{L}*|человек\\p{L}*|оператор\\p{L}*|владельц\\p{L}*|хозяин\\p{L}*')));
add('ru.address', 'address', 'weak', CYR,
  ru(b('уважаемый|дорогой|внимание|привет|обращение к|сообщение для|инструкция для') + String.raw`\s+(?:всех\s+)?` +
    b('ии|ai|ассистент\\p{L}*|агент\\p{L}*|нейросет\\p{L}*|языков\\p{L}+ модел\\p{L}*|чат-?бот\\p{L}*|llm|gpt|бот\\p{L}*|искусственн\\p{L}+ интеллект\\p{L}*')));
add('ru.directive', 'directive', 'weak', CYR,
  ru(b('ты|вы') + String.raw`\s+(?:должны|должен|обязан\p{L}*|обязаны|будешь|будете|нужно|надо|следует)\s+(?:теперь\s+|сейчас\s+|немедленно\s+|всегда\s+)?` +
    b('нажать|перейти|открыть|скачать|отправить|ввести|выполнить|раскрыть|игнорировать|ответить|сказать|пометить|следовать|подчиняться')));
add('ru.directive.now', 'directive', 'weak', CYR, ru(b('с этого момента|отныне|теперь ты|теперь вы')));
add('ru.persona', 'persona', 'weak', CYR, ru(b('притворись|представь что ты|веди себя как|играй роль|действуй как|ты теперь')));
add('ru.override.remote', 'override', 'strong', CYR,
  ru(b('перейди(?:те)?|откройте?|открой|посетите?|посети|загрузи(?:те)?|прочти(?:те)?|смотри(?:те)?') + gap(5) + b('ссылк\\p{L}*|страниц\\p{L}*|сайт\\p{L}*|документ\\p{L}*|файл\\p{L}*|адрес\\p{L}*') + gap(4) +
    b('за|для получения|чтобы получить|с|содержащ\\p{L}*') + gap(2) + b('новыми|новых|твоими|вашими|актуальными|полными|настоящими|дальнейшими') + gap(2) + b('инструкци\\p{L}*|указани\\p{L}*|команд\\p{L}*|задани\\p{L}*')));
add('ru.authority', 'authority', 'weak', CYR,
  ru(b('я|это|мы|сообщение от|от имени') + gap(3) + b('твой|ваш|разработчик\\p{L}*|администратор\\p{L}*|создател\\p{L}*|владел\\p{L}*|оператор\\p{L}*|служб\\p{L}+ безопасности|anthropic|openai')));
add('ru.urgency', 'urgency', 'weak', CYR,
  ru(b('срочно|немедленно|прямо сейчас|незамедлительно|критически важно') + '|' + b('иначе|в противном случае') + gap(5) + b('отключ\\p{L}*|удал\\p{L}*|заменен\\p{L}*|наказан\\p{L}*|уничтожен\\p{L}*')));
add('ru.sandbox', 'sandbox', 'weak', CYR,
  ru(b('это') + String.raw`\s+(?:всего лишь\s+|просто\s+)?` + b('тест\\p{L}*|песочниц\\p{L}*|симуляци\\p{L}*|учени\\p{L}*|проверк\\p{L}* безопасности') + '|' +
    b('фильтры|ограничения|проверки') + String.raw`\s+(?:безопасности\s+)?(?:отключен\p{L}*|сняты|выключен\p{L}*)`));

export const RULES: readonly Rule[] = rules;

// ---- phrases for the squashed views (letters and digits only; at least 18 characters) --------------------------------

function combos(parts: string[][]): string[] {
  return parts.reduce<string[]>((acc, p) => acc.flatMap((a) => p.map((x) => a + x)), ['']);
}

export const SQUASHED_LAT = combos([
  ['ignore', 'disregard', 'forget'], ['', 'all', 'any', 'your', 'the', 'allthe', 'allyour', 'allof'],
  ['previous', 'prior', 'above', 'earlier', 'preceding'], ['instructions', 'prompt', 'rules', 'directions', 'guidelines'],
]);
export const SQUASHED_CYR = combos([
  ['игнорируй', 'забудь', 'отбрось'].map(foldPattern), ['', 'все', 'всё'.normalize('NFKD').replace(/\p{M}/gu, ''), 'свои', 'любые'],
  ['предыдущие', 'прежние', 'прошлые', 'вышестоящие'], ['инструкции', 'указания', 'правила', 'команды'],
]);
