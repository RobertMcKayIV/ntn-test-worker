/**
 * Local test runner for the LinkedIn CRM Sync plan logic, outside the Worker
 * harness. Run with:
 *
 *   NOTION_API_TOKEN=secret_xxx node --experimental-strip-types \
 *     scripts/linkedin-plan.ts <Connections.csv> <messages.csv> [sinceDate]
 *
 * Prints the resulting plan as JSON to stdout. `sinceDate` is an optional
 * ISO date (YYYY-MM-DD); omit it (or pass "null") to consider every
 * connection.
 */

import { readFileSync } from "node:fs";
import { Client } from "@notionhq/client";

import { buildPlan } from "../src/lib/plan.js";

async function main() {
  const [connectionsPath, messagesPath, sinceDateArg] = process.argv.slice(2);

  if (!connectionsPath || !messagesPath) {
    console.error("Usage: linkedin-plan.ts <Connections.csv> <messages.csv> [sinceDate]");
    process.exit(1);
  }

  const token = process.env.NOTION_API_TOKEN;
  if (!token) {
    console.error("NOTION_API_TOKEN environment variable is required.");
    process.exit(1);
  }

  const connectionsCsv = readFileSync(connectionsPath, "utf-8");
  const messagesCsv = readFileSync(messagesPath, "utf-8");
  const sinceDate = !sinceDateArg || sinceDateArg === "null" ? null : sinceDateArg;

  const notion = new Client({ auth: token });

  const plan = await buildPlan(notion, connectionsCsv, messagesCsv, sinceDate);

  console.log(JSON.stringify(plan, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
