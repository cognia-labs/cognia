/** Deterministic lexical expansion. No models, runtime adapters or network I/O. */

/**
 * Extract keywords from query
 */
export function extractKeywords(query: string): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "up",
    "about",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "s",
    "t",
    "just",
    "don",
    "now",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
    "am",
    "it",
    "its",
    "and",
    "but",
    "if",
    "or",
    "because",
    "as",
    "until",
    "while",
    "although",
    "though",
    "after",
    "before",
    "unless",
    "i",
    "me",
    "my",
    "myself",
    "we",
    "our",
    "ours",
    "ourselves",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
    "he",
    "him",
    "his",
    "himself",
    "she",
    "her",
    "hers",
    "herself",
    "they",
    "them",
    "their",
    "theirs",
  ])

  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))

  // Deduplicate
  return [...new Set(words)]
}

/**
 * Generate synonyms for keywords (lightweight, rule-based)
 */
export function generateSynonyms(keywords: string[]): Map<string, string[]> {
  // Common synonym mappings
  const synonymMap: Record<string, string[]> = {
    create: ["make", "build", "generate", "develop", "produce"],
    delete: ["remove", "erase", "clear", "destroy"],
    update: ["modify", "change", "edit", "revise", "alter"],
    get: ["retrieve", "fetch", "obtain", "acquire"],
    find: ["search", "locate", "discover", "look for"],
    show: ["display", "present", "reveal", "demonstrate"],
    use: ["utilize", "employ", "apply", "leverage"],
    add: ["insert", "include", "append", "attach"],
    start: ["begin", "initiate", "launch", "commence"],
    stop: ["end", "halt", "terminate", "cease"],
    error: ["bug", "issue", "problem", "fault", "defect"],
    fix: ["repair", "solve", "resolve", "correct"],
    fast: ["quick", "rapid", "speedy", "efficient"],
    slow: ["sluggish", "delayed", "laggy"],
    big: ["large", "huge", "massive", "enormous"],
    small: ["tiny", "little", "compact", "minimal"],
    new: ["recent", "latest", "fresh", "modern"],
    old: ["legacy", "outdated", "previous", "former"],
    good: ["excellent", "great", "best", "optimal"],
    bad: ["poor", "wrong", "incorrect", "invalid"],
    help: ["assist", "support", "guide", "aid"],
    config: ["configuration", "settings", "options", "preferences"],
    configure: ["setup", "set up", "customize"],
    install: ["setup", "deploy", "implement"],
    file: ["document", "data", "resource"],
    function: ["method", "procedure", "operation", "routine"],
    api: ["interface", "endpoint", "service"],
    database: ["db", "datastore", "storage"],
    user: ["account", "member", "client"],
    authentication: ["auth", "login", "signin", "credentials"],
    authorization: ["permission", "access", "rights"],
  }

  const result = new Map<string, string[]>()

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase()
    if (synonymMap[lowerKeyword]) {
      result.set(keyword, synonymMap[lowerKeyword])
    }
  }

  return result
}

/**
 * Expand query with synonyms
 */
export function expandWithSynonyms(query: string): string[] {
  const keywords = extractKeywords(query)
  const synonyms = generateSynonyms(keywords)
  const expansions: string[] = [query]

  for (const [keyword, syns] of synonyms) {
    // Generate a variant for the first synonym of each keyword
    if (syns.length > 0) {
      const variant = query.replace(new RegExp(`\\b${keyword}\\b`, "gi"), syns[0])
      if (variant !== query) {
        expansions.push(variant)
      }
    }
  }

  return expansions
}

/**
 * Return `text` with any NEW synonym terms appended, so a BM25 search widens
 * recall (verbatim ids, alternate verbs) while the original phrasing stays
 * dominant. Returns the trimmed input unchanged when there are no synonyms to
 * add (or the input is blank).
 */
export function buildExpandedKeywordQuery(text: string): string {
  const base = text.trim()
  if (base.length === 0) return base

  // `expandWithSynonyms` returns `[original, ...variants]`; collect the terms
  // that appear in the variants but not in the original.
  const baseTerms = new Set(base.toLowerCase().split(/\s+/).filter(Boolean))
  const appended = new Set<string>()
  for (const variant of expandWithSynonyms(base)) {
    if (variant === base) continue
    for (const raw of variant.split(/\s+/)) {
      const term = raw.trim()
      if (term.length > 1 && !baseTerms.has(term.toLowerCase())) {
        appended.add(term)
      }
    }
  }

  return appended.size > 0 ? `${base} ${[...appended].join(" ")}` : base
}
