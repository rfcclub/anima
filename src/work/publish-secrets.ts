type SecretMatch = { start: number; end: number; kind: string };

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function addRegexMatches(text: string, matches: SecretMatch[], pattern: RegExp, kind: string, group = 0): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[group];
    if (!value) continue;
    const start = match.index! + (group === 0 ? 0 : match[0].indexOf(value));
    matches.push({ start, end: start + value.length, kind });
  }
}

/**
 * A part of a name or path looks like a word or a number: 1 to 3 characters, digits, or lowercase letters (then up to
 * 4 digits: `v1`, `sha256`) with a vowel and no run of 6 consonants. Random lowercase pieces mostly fail this.
 */
function wordPart(part: string): boolean {
  const lower = part.toLowerCase();
  return (
    lower.length <= 3 ||
    /^[0-9]{1,8}$/.test(lower) ||
    /^v[0-9]{1,2}[a-z]{0,6}$/.test(lower) ||
    (/^[a-z]+[0-9]{0,4}$/.test(lower) && /[aeiouy]/.test(lower) && !/[^aeiouy0-9]{6,}/.test(lower))
  );
}

/** The share of the characters in `words` that sit in words of 3 characters or fewer: real names keep it low, a credential cut into tiny pieces does not. */
function shortShare(words: string[]): number {
  const total = words.reduce((n, word) => n + word.length, 0);
  return total === 0 ? 1 : words.reduce((n, word) => n + (word.length <= 3 ? word.length : 0), 0) / total;
}

/** Words that mark a real path (a URL, a source tree, a package layout). A run with none of them is not exempted as a path. */
const PATH_WORDS = new Set(
  ("src lib libs bin dist build out test tests spec specs docs doc node_modules packages package scripts config configs app apps api " +
    "v1 v2 v3 v4 users user home usr var etc tmp opt private repos repo issues pulls pull blob tree raw master main heads refs ref git " +
    "github com org net io www static assets public images img components pages utils helpers types models services server client " +
    "index readme openspec changes data dev examples vendor modules source sources internal core common shared " +
    "plans plan notes guide guides reports report design tasks task release releases commit commits actions workflows wiki compare files " +
    // directory names of this project's own tree (see CLAUDE.md) and the words its paths are built from
    "agents continuity garden narrative memory channels session sessions cartridge cartridges conversation cost identity runtime substrate " +
    "mesh agora hive colony castle engine stage scene render loader briefs projection places presence reflection prompter handler handlers " +
    "manager telegram features store stores adapter adapters hooks plugins tools skills prompts anima bruno orca work review loop pipeline " +
    "ui castle2 town logs vn assets styles services components routes pages cache context ingestion gateway headless identity-runtime").split(" "),
);

/**
 * Identifier shapes that are code, not credentials: camelCase, PascalCase, UUIDs, and snake/kebab/SCREAMING names made
 * of letters only. Every word of a name must look like a word (`wordPart`) and words of 3 characters or fewer are at most half of it, so `qavjklmn-wexrtypl-zibqwrst-fudghk`
 * (consonant clusters) is not exempt. Anything else (digits, `+`, `/`, `=`, mixed case that is not word-shaped,
 * all-lowercase letters) is not exempt.
 */
function identifierShape(value: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true; // a UUID
  const name = value.replace(/^[_-]+|[_-]+$/g, "");
  const shaped =
    /^[a-z]+(?:[A-Z][a-z]+)+$/.test(name) ||
    /^(?:[A-Z][a-z]+)+$/.test(name) ||
    /^(?:[a-z]+|[A-Z]+|[0-9]+)(?:[_-](?:[a-z]+|[A-Z]+|[0-9]+))+$/.test(name);
  const words = name.match(/[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
  return shaped && words.every(wordPart) && shortShare(words) <= 0.5;
}

/**
 * Generic rule, deliberately simple so reviewers can reason about it:
 *  - a candidate is a maximal run of base64 characters (`=` included, so `key=<token>` or a token with an inner `=` is one run); `/` stays inside the run (it is a base64 character) and
 *    `.`, `:`, `@`, `?`, `&`, quotes, spaces and brackets end it, so a hostname or a sentence never joins a token;
 *  - to decide, leading and trailing path pieces that are plain lowercase words (`/send`, `/v1`) are set aside; the
 *    rest needs 32+ characters, entropy of 4.0+ and must not be an identifier shape (camelCase, PascalCase,
 *    snake/kebab words). There is NO character-class requirement: a lowercase-only or digit-free credential counts;
 *  - when it counts, the WHOLE run is redacted (minus empty edge pieces), so no fragment of the credential stays;
 *  - a run of 32+ hexadecimal characters with entropy 3.0+ is a credential too, with no exemption for the length
 *    of a Git or SHA-256 id, and is found next to `=` or any other punctuation.
 * It is a gate against accidental leaks and prefers refusing.
 */
function addGenericTokens(text: string, matches: SecretMatch[]): void {
  // The intent specifies 4.0 bits a character for every generic token, capital letter or not. The cost is measured in design.md: random lowercase-only runs miss it 37% of the time at 32 characters and 9% at 40.
  const qualifies = (value: string) => value.length >= 32 && entropy(value) >= 4 && !identifierShape(value);
  // A path piece looks like a word or a number (see `wordPart`); a piece that itself qualifies is a credential, not a word.
  const lowerWord = (piece: string) =>
    piece === "" || ((identifierShape(piece) || piece.split(/[-_]/).every(wordPart)) && !qualifies(piece));
  // A piece that reads as part of a real path: a number, a known path word (`src`, `v1`, `users`), or a multi-word name (`work-engineer`, `buildSystemPrompt`).
  const pathPiece = (piece: string) =>
    /^[0-9]{1,8}$/.test(piece) ||
    piece.split(/[-_]/).some((part) => PATH_WORDS.has(part)) ||
    (identifierShape(piece) && /[-_A-Z]/.test(piece));
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const pieces = match[0].split("/");
    // Path pieces (numbers, known path words, multi-word names) are set aside; whatever is left must not itself be a
    // token. A credential wrapped in real path words (`api/src/lib/v1/<token>`) keeps its own length and entropy.
    const rest = pieces.filter((piece) => piece !== "" && !pathPiece(piece)).join("/");
    const restIsToken = pieces.length > 1 && qualifies(rest);
    if (pieces.length > 1 && pieces.every(lowerWord) && !restIsToken) continue;
    let from = 0;
    let to = pieces.length;
    while (from < to && lowerWord(pieces[from]!)) from++;
    while (to > from && lowerWord(pieces[to - 1]!)) to--;
    const core = pieces.slice(from, to).join("/");
    // If setting path words aside took part of a credential (a short lowercase piece after a slash), judge the whole run.
    if (!restIsToken && !qualifies(core) && !qualifies(match[0].replace(/=+$/, ""))) continue;
    const lead = match[0].length - match[0].replace(/^[/=]+/, "").length;
    const trail = match[0].length - match[0].replace(/[/=]+$/, "").length;
    matches.push({ start: match.index! + lead, end: match.index! + match[0].length - trail, kind: "high-entropy-token" });
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g)) {
    if (entropy(match[0]) >= 3) matches.push({ start: match.index!, end: match.index! + match[0].length, kind: "high-entropy-hex" });
  }
}

/**
 * True when the line text is exactly one call (`name(...)`, balanced) or one `${...}`, followed only by member calls (`.trim()`) and terminators.
 * `Hunter(2)IsMySecretPass!!` is not code: text follows the closing parenthesis.
 */
function isWholeCode(line: string): boolean {
  const open = /^(?:\$\{|[A-Za-z_$][\w$.]*\()/.exec(line);
  if (!open) return false;
  const [opener, closer] = open[0] === "${" ? ["{", "}"] : ["(", ")"];
  let depth = 0;
  for (let i = open[0].length - 1; i < line.length; i++) {
    if (line[i] === opener) depth++;
    else if (line[i] === closer && --depth === 0) return /^(?:\.[\w$]+\([^()]*\))*[\s;,)\]}]*$/.test(line.slice(i + 1));
  }
  return false;
}

function findMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  // Whole PEM blocks redact their body; the second pattern retains detection of incomplete headers.
  addRegexMatches(text, matches, /-----BEGIN ([^\r\n]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, "private-key");
  addRegexMatches(text, matches, /-----BEGIN [^\r\n]*PRIVATE KEY-----/g, "private-key");
  addRegexMatches(text, matches, /\b(?:ghp_|ghs_|gho_|github_pat_)[A-Za-z0-9_]{20,}/g, "github-token");
  addRegexMatches(text, matches, /\bsk-[A-Za-z0-9_-]{20,}/g, "sk-key");
  addRegexMatches(text, matches, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws-access-key-id");
  addRegexMatches(text, matches, /\baws_secret_access_key\s*(?:[=:]\s*|(?=["']))["']?\s*([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/])/gi, "aws-secret-access-key", 1);
  addRegexMatches(text, matches, /\bxox[abprs]-[A-Za-z0-9-]+/g, "slack-token");
  addRegexMatches(text, matches, /\bAIza[A-Za-z0-9_-]{35}\b/g, "google-api-key");
  addRegexMatches(text, matches, /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g, "jwt");

  // Assignment scanning stays on raw text so dotted password values cannot evade the rule.
  const sensitiveName = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
  // The value is everything up to the closing quote, skipping backslash-escaped characters (quoted) or the next space, quote, comma or semicolon (bare), so
  // `!@#$%&*` inside a password does not cut it short.
  const assignmentPattern = /\b([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=|:)\s*(?:"((?:\\.|[^"\\\r\n]){16,})"|'((?:\\.|[^'\\\r\n]){16,})'|`((?:\\.|[^`\\\r\n]){16,})`|["']?([^\s"'`,;]{16,}))/g;
  for (const match of text.matchAll(assignmentPattern)) {
    const name = match[1]!;
    const value = (match[2] ?? match[3] ?? match[4] ?? match[5])!;
    if (!sensitiveName.test(name)) continue;
    const before = text.slice(Math.max(0, match.index! - 20), match.index!);
    if (/\b(?:process\.env\.|options\.|this\.|config\.|env\.)$/i.test(before)) continue;
    if (/^(?:process\.env\.|options\.|this\.|config\.|env\.)/i.test(value)) continue;
    // A bare value that is, from its start to the end of the line, one call or one `${...}` interpolation is code.
    if (match[5] !== undefined && isWholeCode(text.slice(match.index! + match[0].lastIndexOf(value)).split(/\r?\n/, 1)[0]!)) continue;
    const start = match.index! + match[0].lastIndexOf(value);
    matches.push({ start, end: start + value.length, kind: "sensitive-assignment" });
  }

  addGenericTokens(text, matches);
  return matches;
}

/** Return the kind of the first detected secret, never its value. */
export function scanSecrets(text: string): string | null {
  const first = findMatches(text).sort((a, b) => a.start - b.start)[0];
  return first?.kind ?? null;
}

/** Replace every detected secret range with a fixed marker. */
export function redactSecrets(text: string): string {
  const matches = findMatches(text).sort((a, b) => a.start - b.start || b.end - a.end);
  if (matches.length === 0) return text;

  const merged: Array<{ start: number; end: number }> = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (previous && match.start <= previous.end) previous.end = Math.max(previous.end, match.end);
    else merged.push({ start: match.start, end: match.end });
  }
  let result = "";
  let cursor = 0;
  for (const range of merged) {
    result += text.slice(cursor, range.start) + "[redacted]";
    cursor = range.end;
  }
  return result + text.slice(cursor);
}
