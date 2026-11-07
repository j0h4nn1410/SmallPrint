/** Short page-text snippets that mention money or terms, for the backend to quote from. */
import { ALL_WORDING, NOISE } from "./wording";
import { textLines, uniq } from "./text";

const MAX_SNIPPETS = 15;
const MAX_LEN = 300;
const MONEY = /£\s?\d/;
const TERMS = /\b(?:refill|cylinder|cartridge|warranty|guarantee|returns?|refund|delivery|notice|renew|contract|cancel|fee|charge|compatible|only|exchange)\b/i;

// Never send anything that looks like the user's own details (checkout pages show them).
const PERSONAL = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i, // UK postcode
  /(?:\+44\s?|\b0)7\d{3}\s?\d{6}\b|\b0\d{2,4}\s?\d{3,4}\s?\d{3,4}\b/, // UK phone
  /\b(?:\d{4}[ -]?){3}\d{4}\b|ending (?:in )?\d{4}\b|\*{2,}\s?\d{4}/i, // card numbers
  /\b(?:deliver(?:ing)? to|billing address|delivery address|signed in as|hello,|hi,)\b/i,
];

export function isPersonal(line: string): boolean {
  return PERSONAL.some((p) => p.test(line));
}

export function pickSnippets(roots: Element[], preferred: string[] = []): string[] {
  const lines = roots.flatMap((r) => textLines(r));
  const relevant = lines.filter((l) => l.length >= 12 && (MONEY.test(l) || TERMS.test(l) || ALL_WORDING.some((p) => p.test(l))));
  return uniq([...preferred, ...relevant])
    .map((l) => (l.length > MAX_LEN ? `${l.slice(0, MAX_LEN - 1)}…` : l))
    .filter((l) => !isPersonal(l) && !NOISE.test(l))
    .slice(0, MAX_SNIPPETS);
}
