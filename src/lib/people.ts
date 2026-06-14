import type { PageObjectResponse } from "@notionhq/client";
import type { Client } from "@notionhq/client";

import {
  CONTACTS_DATA_SOURCE_ID,
  NAME_PROP,
  LINKEDIN_PROP,
  EMAIL_PROP,
  STATUS_PROP,
  CONNECTIONS_RELATION_PROP,
  TOUCHPOINTS_PROP,
} from "./config.js";
import type { PeopleRecord } from "./linkedin.js";

export function plainText(richText: { plain_text: string }[] | undefined): string {
  return (richText ?? []).map((t) => t.plain_text).join("");
}

export function extractPeopleRecord(page: PageObjectResponse): PeopleRecord {
  const props = page.properties as Record<string, any>;
  const name = props[NAME_PROP]?.type === "title" ? plainText(props[NAME_PROP].title) : "";
  const linkedin = props[LINKEDIN_PROP]?.type === "url" ? (props[LINKEDIN_PROP].url ?? "") : "";
  const email = props[EMAIL_PROP]?.type === "email" ? (props[EMAIL_PROP].email ?? "") : "";
  const contactStatus = props[STATUS_PROP]?.type === "status" ? (props[STATUS_PROP].status?.name ?? null) : null;
  const linkedinConnections: string[] =
    props[CONNECTIONS_RELATION_PROP]?.type === "relation"
      ? props[CONNECTIONS_RELATION_PROP].relation.map((r: { id: string }) => r.id)
      : [];
  const hasTouchpoints = props[TOUCHPOINTS_PROP]?.type === "relation" && props[TOUCHPOINTS_PROP].relation.length > 0;

  return {
    url: page.id,
    name,
    linkedin: linkedin ?? "",
    email: email ?? "",
    contactStatus,
    linkedinConnections,
    hasTouchpoints,
  };
}

export async function fetchAllPeople(notion: Client): Promise<PeopleRecord[]> {
  const people: PeopleRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion.dataSources.query({
      data_source_id: CONTACTS_DATA_SOURCE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const result of page.results) {
      if ("properties" in result) {
        people.push(extractPeopleRecord(result as PageObjectResponse));
      }
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return people;
}
