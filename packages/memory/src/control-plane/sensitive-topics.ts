/**
 * Local, deterministic sensitive-topic classifier for long-term memory governance (`G3`).
 *
 * Distinct from `@cognia/redact` PII detection: PII looks for identifiers
 * (emails, phone numbers, SSNs, keys), whereas sensitive topics cover special-
 * category personal facts (health/medical conditions, religious or political
 * beliefs, personal finances/debt, and protected identity attributes) that
 * contain zero structured PII tokens yet still require explicit user consent
 * before automatic background learning injects them into future prompts.
 */

import type { SensitiveMemoryCategory } from "../types/memory"

export interface SensitiveTopicClassification {
  sensitive: boolean
  categories: SensitiveMemoryCategory[]
}

interface CategoryRule {
  category: SensitiveMemoryCategory
  patterns: readonly RegExp[]
}

/**
 * Bilingual (English + Chinese) patterns tuned for high precision on personal
 * memory statements while avoiding developer/project false positives (e.g.,
 * "token budget", "git identity", "health check endpoint", "database migration").
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "health",
    patterns: [
      /\b(?:diagnosed with|diagnosis of|chronic illness|medical condition|prescription|medications?|taking (?:ssri|antidepressants?|insulin|medication)|mental health|psychiatrist|psychotherapy|in therapy|chemotherapy|pregnant|pregnancy|trimester|diabetes|hypertension|depression|anxiety disorder|bipolar|adhd|autism|asthma|epilepsy|cancer|surgery recovery|allergic to)\b/i,
      /(?:确诊|患有|慢性病|病史|处方药|服用.*药|抑郁症|焦虑症|双相情感|糖尿病|高血压|哮喘|过敏史|怀孕|孕期|化疗|心理治疗|精神科|手术康复)/,
    ],
  },
  {
    category: "beliefs",
    patterns: [
      /\b(?:religious beliefs?|my religion|practicing (?:christian|muslim|jew|buddhist|hindu|catholic)|attend (?:church|mosque|synagogue|temple)|orthodox jew|devout|atheist|agnostic|political (?:beliefs?|views?|affiliation|party)|voted for|registered (?:democrat|republican|independent)|libertarian|socialist|conservative voter|liberal voter)\b/i,
      /(?:宗教信仰|信奉|基督徒|天主教徒|穆斯林|佛教徒|无神论者|去教堂|做礼拜|政治立场|政党倾向|政治信仰|投票给)/,
    ],
  },
  {
    category: "finance",
    patterns: [
      /\b(?:my (?:annual |monthly |base )?(?:salary|income|net worth|debt|mortgage|credit score)|personal (?:debt|bankruptcy|loan|finances)|filed for bankruptcy|student loans?|credit card debt|behind on rent|paycheck to paycheck|tax return|alimony)\b/i,
      /(?:个人(?:负债|债务|破产|存款|资产|收入|征信)|我的(?:年薪|月薪|工资|房贷|车贷|信用卡欠款|净资产|存款)|拖欠房租|征信逾期)/,
    ],
  },
  {
    category: "identity",
    patterns: [
      /\b(?:sexual orientation|gender identity|identify as (?:gay|lesbian|bisexual|queer|pansexual|asexual|transgender|non-binary|nonbinary)|transgender|non-binary|ethnic minority|racial background|immigration status|asylum seeker|undocumented|trade union member|labor union member|physical disability|wheelchair user)\b/i,
      /(?:性取向|性别认同|跨性别|非二元性别|同性恋|双性恋|少数族裔|移民身份|政治庇护|工会成员|残障人士|身体残疾)/,
    ],
  },
]

const TECHNICAL_EXCLUSIONS: readonly RegExp[] = [
  /\b(?:health[- ]check|liveness probe|readiness probe|service health|memory health|cluster health|database health|api health)\b/i,
  /\b(?:git identity|acting[- ]identity|caller identity|transport identity|service principal|oauth|oidc|jwt)\b/i,
  /\b(?:token budget|recall budget|latency budget|technical debt|tech debt|aws billing|cloud billing)\b/i,
]

export function classifySensitiveMemoryTopic(
  text: string | null | undefined
): SensitiveTopicClassification {
  const normalized = typeof text === "string" ? text.trim() : ""
  if (!normalized) return { sensitive: false, categories: [] }

  // Strip benign technical compound terms first so "service health check" or
  // "technical debt" never trip personal health/finance rules while mixed
  // sentences ("fixing tech debt while dealing with my credit card debt") still match.
  let scrubbed = normalized
  for (const exclusion of TECHNICAL_EXCLUSIONS) {
    scrubbed = scrubbed.replace(new RegExp(exclusion.source, "gi"), " ")
  }

  const categories: SensitiveMemoryCategory[] = []
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(scrubbed))) {
      categories.push(rule.category)
    }
  }

  return {
    sensitive: categories.length > 0,
    categories,
  }
}
