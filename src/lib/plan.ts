import type { Client } from "@notionhq/client";

import { parseCsv, parseConnectionsCsv } from "./csv.js";
import {
  buildConnectionSummaries,
  buildPeopleIndex,
  matchConnection,
  type ConnectionSummary,
} from "./linkedin.js";
import { MY_LINKEDIN_URL, MY_PEOPLE_RECORD_ID } from "./config.js";
import { fetchAllPeople } from "./people.js";

export interface PlanConnectionSummary {
  fullName: string;
  linkedinUrl: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
  totalMessages: number;
}

export interface PlanCreate {
  connection: PlanConnectionSummary;
}

export interface PlanUpdate {
  personId: string;
  personName: string;
  matchMethod: string;
  connection: PlanConnectionSummary;
  fillLinkedin: boolean;
  fillEmail: boolean;
  addConnectionRelation: boolean;
}

export interface PlanFuzzyCandidate {
  connection: PlanConnectionSummary;
  candidatePersonId: string;
  candidatePersonName: string;
  score: number;
}

export interface SyncPlan {
  stats: {
    connectionsInExport: number;
    inScope: number;
    creates: number;
    updates: number;
    fuzzyCandidates: number;
  };
  creates: PlanCreate[];
  updates: PlanUpdate[];
  fuzzyCandidates: PlanFuzzyCandidate[];
}

function toPlanSummary(s: ConnectionSummary): PlanConnectionSummary {
  return {
    fullName: s.fullName,
    linkedinUrl: s.urlNorm,
    email: s.email,
    company: s.company,
    position: s.position,
    connectedOn: s.connectedOn,
    totalMessages: s.totalMessages,
  };
}

export async function buildPlan(
  notion: Client,
  connectionsCsv: string,
  messagesCsv: string,
  sinceDate: string | null,
): Promise<SyncPlan> {
  const connections = parseConnectionsCsv(connectionsCsv);
  const messages = parseCsv(messagesCsv).filter((m) => (m["IS MESSAGE DRAFT"] ?? "No") === "No");

  const summaries = buildConnectionSummaries(connections, messages, MY_LINKEDIN_URL);
  const people = await fetchAllPeople(notion);
  const index = buildPeopleIndex(people);

  const inScope = sinceDate ? summaries.filter((s) => s.connectedOn > sinceDate) : summaries;

  const creates: PlanCreate[] = [];
  const updates: PlanUpdate[] = [];
  const fuzzyCandidates: PlanFuzzyCandidate[] = [];

  for (const summary of inScope) {
    const result = matchConnection(summary, index);

    if (result.method === "no_match") {
      creates.push({ connection: toPlanSummary(summary) });
    } else if (result.method.startsWith("fuzzy:")) {
      const score = Number(result.method.slice("fuzzy:".length));
      fuzzyCandidates.push({
        connection: toPlanSummary(summary),
        candidatePersonId: result.match!.url,
        candidatePersonName: result.match!.name,
        score,
      });
    } else {
      const person = result.match!;
      updates.push({
        personId: person.url,
        personName: person.name,
        matchMethod: result.method,
        connection: toPlanSummary(summary),
        fillLinkedin: !person.linkedin,
        fillEmail: !person.email && !!summary.email,
        addConnectionRelation: !person.linkedinConnections.includes(MY_PEOPLE_RECORD_ID),
      });
    }
  }

  return {
    stats: {
      connectionsInExport: summaries.length,
      inScope: inScope.length,
      creates: creates.length,
      updates: updates.length,
      fuzzyCandidates: fuzzyCandidates.length,
    },
    creates,
    updates,
    fuzzyCandidates,
  };
}
