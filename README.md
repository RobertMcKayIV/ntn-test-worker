# LinkedIn CRM Sync — Notion Worker

A Notion Worker that does the deterministic, bug-prone parts of the
"LinkedIn CRM Sync" skill (see the AI Agent Instructions & Skills DB) in
code instead of inside an LLM sandbox session. This fixes the failure mode
documented in that skill's implementation notes (duplicate People records
created after the LLM session's context window overflowed mid-run).

## What it does

Two **tool** capabilities, callable from a Notion Custom Agent (or via
`ntn workers exec` for testing):

- **`linkedinSyncPlan`** (read-only) — takes the raw text of `Connections.csv`
  and `messages.csv` from a LinkedIn data export, plus an optional
  `sinceDate` cutoff, and returns a plan:
  - `creates` — connections with no matching People record
  - `updates` — connections matched to an existing People record (by
    LinkedIn URL, email, or exact name), with flags for which fields are
    currently empty and would be filled
  - `fuzzyCandidates` — name-similarity matches (>= 0.80) that need a human
    to confirm before being treated as a match
  - `statusChanges` — Contact Status updates for every People record already
    linked to Robert via "LinkedIn Connections", computed from message
    history (mirrors Step 4 of the original skill)

- **`linkedinSyncApply`** — takes a list of actions (`create_person`,
  `update_person`, `update_status`), each derived from the plan above
  (typically after a human reviews `creates`/`fuzzyCandidates`/`statusChanges`
  in chat), and performs the writes. `update_person` only fills properties
  that are currently empty — it never overwrites existing data.

## Matching & status logic

`src/lib/linkedin.ts` is a straight port of the skill's Python logic:

- `normUrl` — canonical LinkedIn URL normalization (scheme, host, trailing
  slash, query string, case)
- `buildConnectionSummaries` — aggregates `messages.csv` per connection
  (total messages, who sent last, whether the connection ever replied, last
  reply date)
- `matchConnection` — URL -> email -> exact name -> fuzzy name (LCS-based
  similarity ratio, threshold 0.80)
- `computeContactStatus` — the Contact Status decision table (protected
  statuses, "Responded (follow up)", "Went cold",
  "Complete (check in periodically)", etc.)

Run `npm test` to run the unit tests for this logic.

## Configuration

Workspace-specific IDs are hardcoded as constants in `src/lib/config.ts`
(taken from the "LinkedIn CRM Sync" skill's Configuration table):

- `MY_LINKEDIN_URL`, `MY_FULL_NAME`, `MY_PEOPLE_RECORD_ID`
- `CONTACTS_DATA_SOURCE_ID`
- Property names on the People data source: `Name`, `LinkedIn`, `Email`,
  `LinkedIn Connections`, `Contact Status`, `Touchpoints`

If any of these drift (property renamed, etc.), update the constants in
`src/lib/config.ts`.

## Local testing (before deploying)

`scripts/linkedin-plan.ts` runs the same plan logic as the `linkedinSyncPlan`
tool, but as a plain Node script against a real Notion workspace via
`@notionhq/client` — no `ntn` CLI or Worker deploy required:

```sh
NOTION_API_TOKEN=secret_xxx npm run linkedin-plan -- \
  /path/to/Connections.csv /path/to/messages.csv [sinceDate]
```

- `NOTION_API_TOKEN` must be an internal integration token with access to the
  People data source (`CONTACTS_DATA_SOURCE_ID` in `src/lib/config.ts`).
- `sinceDate` is optional (ISO `YYYY-MM-DD`); omit it or pass `null` to
  consider every connection.
- Prints the plan as JSON to stdout. Pipe to a file (`> plan.json`) and
  review `stats`, `creates`, `fuzzyCandidates`, and `statusChanges` before
  building any `linkedinSyncApply` actions.

## Status

**Not yet deployed.** This session could not install the `ntn` CLI
(`curl -fsSL https://ntn.dev | bash`, or `npm install --global ntn`) because
piping a remote script into a shell is blocked by this environment's
permission policy.

To deploy:

```sh
curl -fsSL https://ntn.dev | bash   # install the Notion CLI (macOS/Linux; WSL on Windows)
ntn login                           # authenticate with the workspace
cd ntn-test-worker
ntn workers deploy                  # build and upload
```

Requires the workspace to be on a Business/Enterprise plan with Workers
enabled (a workspace owner enables this in workspace settings).

## Suggested next steps

1. Deploy and attach `linkedinSyncPlan` as a tool to a Custom Agent.
2. Run it against a fresh `Connections.csv` + `messages.csv` export with
   `sinceDate: null` for a first full pass; review `stats` before doing
   anything else (a `creates` count over ~1500 likely means a normalization
   bug — same warning as the original skill).
3. Review `fuzzyCandidates` and `statusChanges` with Robert in chat, then
   build the `actions` array for `linkedinSyncApply` from the confirmed
   items.
4. Consider a follow-up **sync** capability that pulls Contact Status
   changes on a schedule without requiring a fresh CSV export each time
   (message history would need a different data source, since LinkedIn
   doesn't offer a live messages API).
