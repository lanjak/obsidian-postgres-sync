import assert from "node:assert/strict";
import test from "node:test";
import { checkPushSnapshot, decidePushSnapshot, readPushSnapshot } from "../src/push-snapshot";

test("an edit during a delayed upload cannot become a newer stale remote update", async () => {
  const file = { path: "Daily Notes/2026-08-31.md", stat: { mtime: 100 } };
  let content = "first draft";

  const snapshot = await readPushSnapshot(
    file,
    async () => {
      file.stat.mtime = 150;
      return content;
    },
    async (text) => `hash:${text}`,
  );

  content = "first draft with new text";
  file.stat.mtime = 200;

  assert.deepEqual(snapshot, {
    path: "Daily Notes/2026-08-31.md",
    content: "first draft",
    contentHash: "hash:first draft",
    mtime: 150,
    size: 11,
  });
  assert.deepEqual(
    await checkPushSnapshot(snapshot, async () => content, async () => undefined),
    { decision: "retry", remote: undefined },
  );
});

test("a local edit during remote lookup is retried instead of pulled", () => {
  const snapshot = {
    path: "Daily Notes/2026-08-31.md",
    content: "first draft",
    contentHash: "hash:first draft",
    mtime: 100,
    size: 11,
  };
  const remote = { contentHash: "hash:remote draft", mtime: 150, deleted: false };

  assert.equal(decidePushSnapshot(snapshot, "first draft with new text", remote), "retry");
});

test("a remote edit during embedding is checked before upload", async () => {
  const snapshot = {
    path: "Daily Notes/2026-08-31.md",
    content: "desktop draft",
    contentHash: "hash:desktop draft",
    mtime: 100,
    size: 13,
  };
  const phoneUpdate = { contentHash: "hash:phone update", mtime: 200, deleted: false };

  const result = await checkPushSnapshot(
    snapshot,
    async () => "desktop draft",
    async () => phoneUpdate,
  );

  assert.deepEqual(result, { decision: "pull", remote: phoneUpdate });
});
