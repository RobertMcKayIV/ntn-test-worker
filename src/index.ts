import { Worker } from "@notionhq/workers";
import { j, type Infer } from "@notionhq/workers/schema-builder";
import type { PageObjectResponse } from "@notionhq/client";

import { normUrl } from "./lib/linkedin.js";
import {
  CONTACTS_DATA_SOURCE_ID,
  NAME_PROP,
  LINKEDIN_PROP,
  EMAIL_PROP,
  CONNECTIONS_RELATION_PROP,
  STATUS_PROP,
  MY_PEOPLE_RECORD_ID,
} from "./lib/config.js";
import { extractPeopleRecord } from "./lib/people.js";
import { buildPlan } from "./lib/plan.js";

const worker = new Worker();
export default worker;

// --- Plan tool --------------------------------------------------------------

const planInputSchema = j.object({
  connectionsCsv: j.string().describe("Raw text contents of LinkedIn Connections.csv (including the 3-line export preamble)."),
  messagesCsv: j.string().describe("Raw text contents of LinkedIn messages.csv."),
  sinceDate: j
    .string()
    .nullable()
    .describe(
      "ISO date (YYYY-MM-DD). Only connections with 'Connected On' strictly after this date are included in " +
        "creates/updates. Pass null on the first run to consider every connection.",
    ),
});

const planSummarySchema = j.object({
  fullName: j.string(),
  linkedinUrl: j.string(),
  email: j.string(),
  company: j.string(),
  position: j.string(),
  connectedOn: j.string(),
  totalMessages: j.integer(),
});

const planOutputSchema = j.object({
  stats: j.object({
    connectionsInExport: j.integer(),
    inScope: j.integer(),
    creates: j.integer(),
    updates: j.integer(),
    fuzzyCandidates: j.integer(),
    statusChanges: j.integer(),
  }),
  creates: j.array(
    j.object({
      connection: planSummarySchema,
    }),
  ),
  updates: j.array(
    j.object({
      personId: j.string(),
      personName: j.string(),
      matchMethod: j.string(),
      connection: planSummarySchema,
      fillLinkedin: j.boolean().describe("True if the person's LinkedIn URL field is currently empty and would be filled."),
      fillEmail: j.boolean().describe("True if the person's Email field is currently empty and would be filled."),
      addConnectionRelation: j
        .boolean()
        .describe("True if this person does not yet have Robert in their LinkedIn Connections relation."),
    }),
  ),
  fuzzyCandidates: j.array(
    j.object({
      connection: planSummarySchema,
      candidatePersonId: j.string(),
      candidatePersonName: j.string(),
      score: j.number(),
    }),
  ),
  statusChanges: j.array(
    j.object({
      personId: j.string(),
      personName: j.string(),
      currentStatus: j.string().nullable(),
      newStatus: j.string().nullable(),
    }),
  ),
});

worker.tool("linkedinSyncPlan", {
  title: "Plan LinkedIn CRM Sync",
  description:
    "Analyzes a LinkedIn Connections.csv + messages.csv export against the People database and returns a " +
    "deterministic plan: which connections need new People records, which existing People records need " +
    "LinkedIn/Email filled in or the LinkedIn Connections relation added, which matches are only fuzzy " +
    "(name similarity) and need human confirmation, and which existing People records (already connected " +
    "on LinkedIn) need a Contact Status update. Performs no writes.",
  schema: planInputSchema,
  outputSchema: planOutputSchema,
  hints: { readOnlyHint: true },
  execute: async ({ connectionsCsv, messagesCsv, sinceDate }, { notion }) => {
    const plan = await buildPlan(notion, connectionsCsv, messagesCsv, sinceDate);
    return plan as unknown as Infer<typeof planOutputSchema>;
  },
});

// --- Apply tool --------------------------------------------------------------

const applyActionSchema = j.object({
  type: j.enum("create_person", "update_person", "update_status"),
  // create_person
  fullName: j.string().nullable().describe("Required for create_person."),
  linkedinUrl: j.string().nullable().describe("Required for create_person and update_person."),
  email: j.string().nullable().describe("Optional for create_person and update_person."),
  // update_person / update_status
  personId: j.string().nullable().describe("Required for update_person and update_status. The People page id."),
  fillLinkedin: j.boolean().nullable().describe("For update_person: set the LinkedIn property to linkedinUrl."),
  fillEmail: j.boolean().nullable().describe("For update_person: set the Email property to email."),
  addConnectionRelation: j
    .boolean()
    .nullable()
    .describe("For update_person: add Robert's People record to the LinkedIn Connections relation."),
  // update_status
  newStatus: j.string().nullable().describe("For update_status: the new Contact Status value, or null to clear it."),
  clearStatus: j.boolean().nullable().describe("For update_status: if true, clear Contact Status regardless of newStatus."),
});

const applyResultSchema = j.object({
  results: j.array(
    j.object({
      index: j.integer(),
      type: j.string(),
      success: j.boolean(),
      personId: j.string().nullable(),
      error: j.string().nullable(),
    }),
  ),
});

worker.tool("linkedinSyncApply", {
  title: "Apply LinkedIn CRM Sync actions",
  description:
    "Executes a batch of write actions produced from a linkedinSyncPlan result (after human confirmation), " +
    "creating new People records, filling in LinkedIn/Email and the LinkedIn Connections relation on existing " +
    "records (without overwriting non-empty values), and updating Contact Status. " +
    "Fuzzy-match candidates should be converted to update_person actions only after a human confirms the match.",
  schema: j.object({ actions: j.array(applyActionSchema) }),
  outputSchema: applyResultSchema,
  execute: async ({ actions }, { notion }) => {
    const results: { index: number; type: string; success: boolean; personId: string | null; error: string | null }[] = [];

    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      try {
        if (action.type === "create_person") {
          if (!action.fullName) throw new Error("fullName is required for create_person");
          const properties: Record<string, unknown> = {
            [NAME_PROP]: { title: [{ text: { content: action.fullName } }] },
            [CONNECTIONS_RELATION_PROP]: { relation: [{ id: MY_PEOPLE_RECORD_ID }] },
          };
          if (action.linkedinUrl) properties[LINKEDIN_PROP] = { url: normUrl(action.linkedinUrl) };
          if (action.email) properties[EMAIL_PROP] = { email: action.email };

          const created = await notion.pages.create({
            parent: { type: "data_source_id", data_source_id: CONTACTS_DATA_SOURCE_ID } as never,
            properties: properties as never,
          });
          results.push({ index, type: action.type, success: true, personId: created.id, error: null });
          continue;
        }

        if (action.type === "update_person") {
          if (!action.personId) throw new Error("personId is required for update_person");
          const properties: Record<string, unknown> = {};
          if (action.fillLinkedin && action.linkedinUrl) {
            properties[LINKEDIN_PROP] = { url: normUrl(action.linkedinUrl) };
          }
          if (action.fillEmail && action.email) {
            properties[EMAIL_PROP] = { email: action.email };
          }
          if (action.addConnectionRelation) {
            const page = (await notion.pages.retrieve({ page_id: action.personId })) as PageObjectResponse;
            const existing = extractPeopleRecord(page).linkedinConnections;
            if (!existing.includes(MY_PEOPLE_RECORD_ID)) {
              properties[CONNECTIONS_RELATION_PROP] = {
                relation: [...existing.map((id) => ({ id })), { id: MY_PEOPLE_RECORD_ID }],
              };
            }
          }
          if (Object.keys(properties).length > 0) {
            await notion.pages.update({ page_id: action.personId, properties: properties as never });
          }
          results.push({ index, type: action.type, success: true, personId: action.personId, error: null });
          continue;
        }

        if (action.type === "update_status") {
          if (!action.personId) throw new Error("personId is required for update_status");
          const statusValue = action.clearStatus ? null : action.newStatus ? { name: action.newStatus } : null;
          await notion.pages.update({
            page_id: action.personId,
            properties: { [STATUS_PROP]: { status: statusValue } } as never,
          });
          results.push({ index, type: action.type, success: true, personId: action.personId, error: null });
          continue;
        }

        throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
      } catch (err) {
        results.push({
          index,
          type: action.type,
          success: false,
          personId: action.personId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { results };
  },
});
