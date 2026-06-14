import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConnectionSummaries,
  buildPeopleIndex,
  computeContactStatus,
  matchConnection,
  normUrl,
  ratio,
} from "./linkedin.ts";

test("normUrl normalizes scheme, host, trailing slash, query, and case", () => {
  assert.equal(normUrl("http://linkedin.com/in/Jane-Doe/"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(normUrl("https://www.linkedin.com/in/jane-doe?utm_source=x"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(normUrl(""), "");
  assert.equal(normUrl(null), "");
});

test("ratio is 1 for identical strings and 0 for disjoint strings", () => {
  assert.equal(ratio("alice smith", "alice smith"), 1);
  assert.equal(ratio("abc", "xyz"), 0);
  assert.ok(ratio("alice smith", "alise smith") > 0.8);
});

const MY_URL = "https://www.linkedin.com/in/robertmckayiv";
const MY_NAME = "Robert McKay";

test("buildConnectionSummaries aggregates message history per connection", () => {
  const connections = [
    {
      "First Name": "Jane",
      "Last Name": "Doe",
      URL: "https://www.linkedin.com/in/jane-doe/",
      "Email Address": "jane@example.com",
      Company: "Acme",
      Position: "CEO",
      "Connected On": "03 Aug 2023",
    },
    {
      "First Name": "No",
      "Last Name": "Messages",
      URL: "https://www.linkedin.com/in/no-messages/",
      "Email Address": "",
      Company: "",
      Position: "",
      "Connected On": "01 Jan 2024",
    },
  ];

  const messages = [
    {
      DATE: "2024-01-01 10:00:00 UTC",
      FROM: "Jane Doe",
      "SENDER PROFILE URL": "https://www.linkedin.com/in/jane-doe",
      "RECIPIENT PROFILE URLS": MY_URL,
      "IS MESSAGE DRAFT": "No",
    },
    {
      DATE: "2024-01-02 10:00:00 UTC",
      FROM: MY_NAME,
      "SENDER PROFILE URL": MY_URL,
      "RECIPIENT PROFILE URLS": "https://www.linkedin.com/in/jane-doe",
      "IS MESSAGE DRAFT": "No",
    },
  ];

  const summaries = buildConnectionSummaries(connections, messages, MY_URL);

  const jane = summaries.find((s) => s.fullName === "Jane Doe")!;
  assert.equal(jane.totalMessages, 2);
  assert.equal(jane.everReplied, true);
  assert.equal(jane.lastMessageFrom, MY_NAME);
  assert.equal(jane.lastReplyDate.slice(0, 10), "2024-01-01");

  const noMsgs = summaries.find((s) => s.fullName === "No Messages")!;
  assert.equal(noMsgs.totalMessages, 0);
  assert.equal(noMsgs.everReplied, false);
});

test("matchConnection prefers URL > email > exact name > fuzzy name", () => {
  const people = [
    { url: "p1", name: "Jane Doe", linkedin: "https://www.linkedin.com/in/jane-doe", email: "", contactStatus: null, linkedinConnections: [], hasTouchpoints: false },
    { url: "p2", name: "John Smith", linkedin: "", email: "john@example.com", contactStatus: null, linkedinConnections: [], hasTouchpoints: false },
    { url: "p3", name: "Alicia Keyes", linkedin: "", email: "", contactStatus: null, linkedinConnections: [], hasTouchpoints: false },
  ];
  const index = buildPeopleIndex(people);

  const byUrl = matchConnection(
    { fullName: "Jane Doe", urlNorm: "https://www.linkedin.com/in/jane-doe", email: "" } as any,
    index,
  );
  assert.equal(byUrl.method, "url");
  assert.equal(byUrl.match?.url, "p1");

  const byEmail = matchConnection({ fullName: "Someone Else", urlNorm: "", email: "john@example.com" } as any, index);
  assert.equal(byEmail.method, "email");
  assert.equal(byEmail.match?.url, "p2");

  const noMatch = matchConnection({ fullName: "Totally Unknown", urlNorm: "", email: "" } as any, index);
  assert.equal(noMatch.method, "no_match");
  assert.equal(noMatch.match, null);

  const fuzzy = matchConnection({ fullName: "Alicia Keys", urlNorm: "", email: "" } as any, index, 0.8);
  assert.match(fuzzy.method, /^fuzzy:/);
  assert.equal(fuzzy.match?.url, "p3");
});

test("computeContactStatus: protected statuses are never touched", () => {
  const decision = computeContactStatus(null, "DNC", false, MY_NAME);
  assert.equal(decision.shouldUpdate, false);
  assert.equal(decision.newStatus, "DNC");
});

test("computeContactStatus: connection's last message -> Responded (follow up)", () => {
  const summary = {
    totalMessages: 1,
    lastMessageFrom: "Jane Doe",
    everReplied: true,
    lastReplyDate: new Date().toISOString(),
  } as any;
  const decision = computeContactStatus(summary, "Cold", false, MY_NAME);
  assert.deepEqual(decision, { newStatus: "Responded (follow up)", shouldUpdate: true });
});

test("computeContactStatus: I sent, never replied -> Accepted Connect but Didn't Write Back", () => {
  const summary = {
    totalMessages: 1,
    lastMessageFrom: MY_NAME,
    everReplied: false,
    lastReplyDate: "",
  } as any;
  const decision = computeContactStatus(summary, "Sent", false, MY_NAME);
  assert.deepEqual(decision, { newStatus: "Accepted Connect but Didn't Write Back", shouldUpdate: true });
});

test("computeContactStatus: I sent, they replied >30d ago -> Went cold", () => {
  const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const summary = {
    totalMessages: 2,
    lastMessageFrom: MY_NAME,
    everReplied: true,
    lastReplyDate: longAgo,
  } as any;
  const decision = computeContactStatus(summary, "Responded (follow up)", false, MY_NAME);
  assert.deepEqual(decision, { newStatus: "Went cold", shouldUpdate: true });
});

test("computeContactStatus: no messages, has touchpoints -> Complete (check in periodically)", () => {
  const decision = computeContactStatus(null, "Cold", true, MY_NAME);
  assert.deepEqual(decision, { newStatus: "Complete (check in periodically)", shouldUpdate: true });
});

test("computeContactStatus: no messages, no touchpoints, clearable status -> clear", () => {
  const decision = computeContactStatus(null, "Met Briefly", false, MY_NAME);
  assert.deepEqual(decision, { newStatus: null, shouldUpdate: true });
});

test("computeContactStatus: no messages, no touchpoints, non-clearable status -> no-op", () => {
  const decision = computeContactStatus(null, "Primary", false, MY_NAME);
  assert.deepEqual(decision, { newStatus: "Primary", shouldUpdate: false });
});
