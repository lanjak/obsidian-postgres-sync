import assert from "node:assert/strict";
import test from "node:test";
import { writeNoteConditionally, type ConditionalRequest } from "../src/conditional-write";

const settings = { postgrestUrl: "https://postgres.example.com", apiToken: "test-token" };
const payload = {
  path: "Daily Notes/2026-08-31.md",
  content: "desktop draft",
  contentHash: "hash:desktop draft",
  mtime: 100,
  size: 13,
  deleted: false,
};

test("a changed remote revision rejects a stale conditional update", async () => {
  let sent: ConditionalRequest | undefined;

  const result = await writeNoteConditionally(settings, "note-id", [0.1], payload, 41, async (request) => {
    sent = request;
    return { status: 200, text: "", json: [] };
  });

  assert.equal(result, "conflict");
  assert.equal(sent?.method, "PATCH");
  assert.equal(sent?.url, "https://postgres.example.com/notes?id=eq.note-id&sync_revision=eq.41&select=sync_revision");
  assert.equal(sent?.headers.Prefer, "return=representation");
});

test("an absent row is inserted only if it remains absent", async () => {
  let sent: ConditionalRequest | undefined;

  const result = await writeNoteConditionally(settings, "note-id", [0.1], payload, undefined, async (request) => {
    sent = request;
    return { status: 201, text: "", json: [{ sync_revision: 42 }] };
  });

  assert.equal(result, "applied");
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.url, "https://postgres.example.com/notes?on_conflict=id&select=sync_revision");
  assert.equal(sent?.headers.Prefer, "resolution=ignore-duplicates,return=representation");
});
