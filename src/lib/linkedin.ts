/**
 * Deterministic core of the LinkedIn CRM Sync skill: CSV normalization,
 * message-history aggregation, People-record matching (exact + fuzzy),
 * and Contact Status computation.
 *
 * This is a straight port of the Python logic from the "LinkedIn CRM Sync"
 * skill (see Notion AI Agent Instructions & Skills DB), with the same
 * normalization rules and the same idempotency guarantees.
 */

/** Canonical LinkedIn URL normalization. Apply identically to both sides of a match. */
export function normUrl(raw?: string | null): string {
  if (!raw) return "";
  let u = raw.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  u = u.replace(/^http:\/\//, "https://");
  u = u.replace(/^https:\/\/linkedin\.com\//, "https://www.linkedin.com/");
  return u;
}

export interface ConnectionSummary {
  firstName: string;
  lastName: string;
  fullName: string;
  urlNorm: string;
  email: string;
  company: string;
  position: string;
  /** ISO date string, or "" if unparseable. */
  connectedOn: string;
  totalMessages: number;
  /** ISO datetime of the most recent message in either direction, or "". */
  lastMessageDate: string;
  /** Display name from the FROM column of the most recent message, or "". */
  lastMessageFrom: string;
  everReplied: boolean;
  /** ISO datetime of the most recent message FROM the connection, or "". */
  lastReplyDate: string;
}

/** Parse a LinkedIn "Connected On" date like "03 Aug 2023" into an ISO date string. */
function parseConnectedOn(raw: string): string {
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function parseMsgDate(raw: string): string {
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Build a per-connection aggregated summary from Connections.csv and
 * messages.csv rows. Equivalent to Step 1 of the LinkedIn CRM Sync skill.
 *
 * `messages` should already be filtered to exclude drafts
 * (`IS MESSAGE DRAFT === "No"`).
 */
export function buildConnectionSummaries(
  connections: Record<string, string>[],
  messages: Record<string, string>[],
  myLinkedinUrl: string,
): ConnectionSummary[] {
  const myUrlNorm = normUrl(myLinkedinUrl);

  // Index messages by normalized sender URL, and (for messages I sent)
  // by each normalized recipient URL, so per-connection lookups are O(1)
  // instead of an O(connections * messages) scan.
  const bySender = new Map<string, Record<string, string>[]>();
  const byRecipient = new Map<string, Record<string, string>[]>();

  for (const m of messages) {
    const senderNorm = normUrl(m["SENDER PROFILE URL"]);
    if (senderNorm) {
      if (!bySender.has(senderNorm)) bySender.set(senderNorm, []);
      bySender.get(senderNorm)!.push(m);
    }
    if (senderNorm === myUrlNorm) {
      const recipients = (m["RECIPIENT PROFILE URLS"] || "")
        .split(",")
        .map((u) => normUrl(u.trim()))
        .filter(Boolean);
      for (const r of recipients) {
        if (!byRecipient.has(r)) byRecipient.set(r, []);
        byRecipient.get(r)!.push(m);
      }
    }
  }

  return connections.map((row) => {
    const urlNorm = normUrl(row["URL"]);
    const firstName = (row["First Name"] || "").trim();
    const lastName = (row["Last Name"] || "").trim();
    const fullName = `${firstName} ${lastName}`.trim();

    const sentBy = bySender.get(urlNorm) ?? [];
    const sentTo = (byRecipient.get(urlNorm) ?? []).filter((m) => normUrl(m["SENDER PROFILE URL"]) === myUrlNorm);

    const seen = new Set<Record<string, string>>();
    const all: Record<string, string>[] = [];
    for (const m of [...sentBy, ...sentTo]) {
      if (!seen.has(m)) {
        seen.add(m);
        all.push(m);
      }
    }

    let lastMessageDate = "";
    let lastMessageFrom = "";
    for (const m of all) {
      const dt = parseMsgDate(m["DATE"] || "");
      if (dt && (!lastMessageDate || dt > lastMessageDate)) {
        lastMessageDate = dt;
        lastMessageFrom = m["FROM"] || "";
      }
    }

    let lastReplyDate = "";
    for (const m of sentBy) {
      const dt = parseMsgDate(m["DATE"] || "");
      if (dt && (!lastReplyDate || dt > lastReplyDate)) lastReplyDate = dt;
    }

    return {
      firstName,
      lastName,
      fullName,
      urlNorm,
      email: (row["Email Address"] || "").trim(),
      company: (row["Company"] || "").trim(),
      position: (row["Position"] || "").trim(),
      connectedOn: parseConnectedOn(row["Connected On"] || ""),
      totalMessages: all.length,
      lastMessageDate,
      lastMessageFrom,
      everReplied: sentBy.length > 0,
      lastReplyDate,
    };
  });
}

export interface PeopleRecord {
  /** Notion page URL (id). */
  url: string;
  name: string;
  linkedin: string;
  email: string;
  contactStatus: string | null;
  /** Page IDs currently in the "LinkedIn Connections" relation. */
  linkedinConnections: string[];
  /** True if the "Touchpoints" relation is non-empty. */
  hasTouchpoints: boolean;
}

interface PeopleIndex {
  byUrl: Map<string, PeopleRecord>;
  byEmail: Map<string, PeopleRecord>;
  byName: Map<string, PeopleRecord>;
}

export function buildPeopleIndex(people: PeopleRecord[]): PeopleIndex {
  const byUrl = new Map<string, PeopleRecord>();
  const byEmail = new Map<string, PeopleRecord>();
  const byName = new Map<string, PeopleRecord>();
  for (const p of people) {
    const nu = normUrl(p.linkedin);
    if (nu && !byUrl.has(nu)) byUrl.set(nu, p);
    const e = (p.email || "").toLowerCase().trim();
    if (e && !byEmail.has(e)) byEmail.set(e, p);
    const n = (p.name || "").toLowerCase().trim();
    if (n && !byName.has(n)) byName.set(n, p);
  }
  return { byUrl, byEmail, byName };
}

/**
 * Similarity ratio in [0, 1], analogous to Python's
 * difflib.SequenceMatcher.ratio() (2*M / (lenA + lenB), where M is the
 * length of the longest common subsequence). Used only as a fuzzy-match
 * fallback; thresholds mirror the original skill (0.80 for People matching).
 */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[m];
  return (2 * lcs) / (n + m);
}

export type MatchMethod = "url" | "email" | "name_exact" | `fuzzy:${string}` | "no_match";

export interface MatchResult {
  summary: ConnectionSummary;
  method: MatchMethod;
  /** The matched People record, if any (including fuzzy candidates). */
  match: PeopleRecord | null;
}

/**
 * Match one connection summary against the People index. Mirrors
 * Step 1c of the LinkedIn CRM Sync skill: URL -> email -> exact name ->
 * fuzzy name (>= fuzzyThreshold, flagged for confirmation, never auto-applied).
 */
export function matchConnection(summary: ConnectionSummary, index: PeopleIndex, fuzzyThreshold = 0.8): MatchResult {
  const email = summary.email.toLowerCase().trim();
  const name = summary.fullName.toLowerCase().trim();

  if (summary.urlNorm && index.byUrl.has(summary.urlNorm)) {
    return { summary, method: "url", match: index.byUrl.get(summary.urlNorm)! };
  }
  if (email && index.byEmail.has(email)) {
    return { summary, method: "email", match: index.byEmail.get(email)! };
  }
  if (name && index.byName.has(name)) {
    return { summary, method: "name_exact", match: index.byName.get(name)! };
  }

  let best = 0;
  let bestRow: PeopleRecord | null = null;
  for (const [pname, prow] of index.byName) {
    const score = ratio(name, pname);
    if (score > best) {
      best = score;
      bestRow = prow;
    }
  }
  if (bestRow && best >= fuzzyThreshold) {
    return { summary, method: `fuzzy:${best.toFixed(2)}`, match: bestRow };
  }
  return { summary, method: "no_match", match: null };
}

const PROTECTED_STATUSES = new Set(["Scheduled", "Complete (check in periodically)", "DNC"]);
const CLEAR_IF_REMAINING = new Set(["Cold", "Secondary", "Event Overlap", "Met Briefly", "Sent"]);

export interface StatusDecision {
  /** New status to write, or null to clear the property. Ignored if shouldUpdate is false. */
  newStatus: string | null;
  shouldUpdate: boolean;
}

/**
 * Compute the Contact Status update for a People record, given its
 * matched connection summary (if any). Mirrors Step 4's compute_status.
 *
 * @param summary - the matched connection summary, or null if this
 *   People record has no corresponding row in the current export
 *   (e.g. it was removed from Connections.csv, or never matched).
 */
export function computeContactStatus(
  summary: ConnectionSummary | null,
  currentStatus: string | null,
  hasTouchpoints: boolean,
  myFullName: string,
  now: Date = new Date(),
): StatusDecision {
  if (currentStatus && PROTECTED_STATUSES.has(currentStatus)) {
    return { newStatus: currentStatus, shouldUpdate: false };
  }

  const total = summary?.totalMessages ?? 0;

  if (total > 0) {
    if (summary!.lastMessageFrom !== myFullName) {
      return { newStatus: "Responded (follow up)", shouldUpdate: true };
    }
    if (!summary!.everReplied) {
      return { newStatus: "Accepted Connect but Didn't Write Back", shouldUpdate: true };
    }
    const lastReply = new Date(summary!.lastReplyDate);
    const daysSince = (now.getTime() - lastReply.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) {
      return { newStatus: "Responded (follow up)", shouldUpdate: true };
    }
    return { newStatus: "Went cold", shouldUpdate: true };
  }

  if (hasTouchpoints) {
    return { newStatus: "Complete (check in periodically)", shouldUpdate: true };
  }
  if (currentStatus && CLEAR_IF_REMAINING.has(currentStatus)) {
    return { newStatus: null, shouldUpdate: true };
  }
  return { newStatus: currentStatus, shouldUpdate: false };
}
