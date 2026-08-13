import assert from "node:assert/strict";
import test from "node:test";
import {
  SyncWorkQueue,
  SerialTaskQueue,
  PriorityTaskQueue,
  SyncFailureStatus,
  reconciliationAction,
  retryDelayMs,
  isSyncablePath,
  embeddingInput,
  findCaseInsensitivePathConflict,
  PathGeneration,
  RemoteChangeGuard,
  RemoteEventSuppressor,
  RemoteContentGuard,
  revisionPageQuery,
  collectRevisionPages,
  type ReconciliationRemote,
} from "../src/recovery";

test("a failed write remains queued with exponential backoff", () => {
  const queue = new SyncWorkQueue();
  queue.markDirty("Recipes/pasta.md");

  assert.equal(queue.begin("Recipes/pasta.md"), true);
  const first = queue.finish("Recipes/pasta.md", false);

  assert.equal(first.shouldSchedule, true);
  assert.equal(first.delayMs, 2_000);
  assert.equal(first.failedAttempts, 1);
  assert.equal(queue.isDirty("Recipes/pasta.md"), true);

  assert.equal(queue.begin("Recipes/pasta.md"), true);
  const second = queue.finish("Recipes/pasta.md", false);
  assert.equal(second.delayMs, 4_000);
  assert.equal(second.failedAttempts, 2);
});

test("an edit made during an active write is not lost", () => {
  const queue = new SyncWorkQueue();
  queue.markDirty("Recipes/pasta.md");
  assert.equal(queue.begin("Recipes/pasta.md"), true);

  queue.markDirty("Recipes/pasta.md");
  const result = queue.finish("Recipes/pasta.md", true);

  assert.equal(result.shouldSchedule, true);
  assert.equal(result.delayMs, 0);
  assert.equal(queue.isDirty("Recipes/pasta.md"), true);
});

test("a successful retry clears failure state", () => {
  const queue = new SyncWorkQueue();
  queue.markDirty("Recipes/pasta.md");
  assert.equal(queue.begin("Recipes/pasta.md"), true);
  queue.finish("Recipes/pasta.md", false);
  assert.equal(queue.begin("Recipes/pasta.md"), true);

  const result = queue.finish("Recipes/pasta.md", true);

  assert.equal(result.recovered, true);
  assert.equal(result.shouldSchedule, false);
  assert.equal(result.failedAttempts, 0);
  assert.equal(queue.isDirty("Recipes/pasta.md"), false);
});

test("retry backoff is capped", () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(20), 300_000);
});

test("reconciliation preserves the newer side", () => {
  const local = { contentHash: "local", mtime: 200 };
  const olderRemote: ReconciliationRemote = { contentHash: "remote", mtime: 100, deleted: false };
  const newerRemote: ReconciliationRemote = { contentHash: "remote", mtime: 300, deleted: false };

  assert.equal(reconciliationAction(local, undefined), "push");
  assert.equal(reconciliationAction(local, olderRemote), "push");
  assert.equal(reconciliationAction(local, newerRemote), "pull");
  assert.equal(reconciliationAction(local, { ...newerRemote, contentHash: "local" }), "none");
  assert.equal(reconciliationAction(local, { ...olderRemote, deleted: true }), "push");
  assert.equal(reconciliationAction(local, { ...newerRemote, deleted: true }), "pull");
});

test("recovery writes run one at a time", async () => {
  const queue = new SerialTaskQueue();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  const jobs = [1, 2, 3, 4].map((job) =>
    queue.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(job);
      active -= 1;
    }),
  );

  await Promise.all(jobs);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("interactive writes jump ahead of queued recovery work", async () => {
  const queue = new PriorityTaskQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    order.push("background-1");
    await firstGate;
  }, "low");
  const second = queue.run(async () => {
    order.push("background-2");
  }, "low");
  const third = queue.run(async () => {
    order.push("background-3");
  }, "low");
  const interactive = queue.run(async () => {
    order.push("interactive");
  }, "high");

  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  await Promise.all([first, second, third, interactive]);
  assert.deepEqual(order, ["background-1", "interactive", "background-2", "background-3"]);
});

test("the newest interactive write jumps ahead of an older startup burst", async () => {
  const queue = new PriorityTaskQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    order.push("startup-1");
    await firstGate;
  }, "high");
  const second = queue.run(async () => {
    order.push("startup-2");
  }, "high");
  const newest = queue.run(async () => {
    order.push("newest-edit");
  }, "high");

  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  await Promise.all([first, second, newest]);
  assert.deepEqual(order, ["startup-1", "newest-edit", "startup-2"]);
});

test("many path failures produce one aggregate failure and one recovery notice", () => {
  const status = new SyncFailureStatus();

  assert.deepEqual(status.failed("a.md"), { notify: true, pending: 1 });
  assert.deepEqual(status.failed("a.md"), { notify: false, pending: 1 });
  assert.deepEqual(status.failed("b.md"), { notify: false, pending: 2 });
  assert.deepEqual(status.failed("c.md"), { notify: false, pending: 3 });
  assert.deepEqual(status.succeeded("a.md"), { notify: false, pending: 2, recovered: 1 });
  assert.deepEqual(status.succeeded("b.md"), { notify: false, pending: 1, recovered: 2 });
  assert.deepEqual(status.succeeded("c.md"), { notify: true, pending: 0, recovered: 3 });
});

test("only vault Markdown notes outside internal folders are syncable", () => {
  assert.equal(isSyncablePath("Personal/Recipes/Pasta.md"), true);
  assert.equal(isSyncablePath(".obsidian/plugins/example.md"), false);
  assert.equal(isSyncablePath(".trash/Deleted.md"), false);
  assert.equal(isSyncablePath(".zairn-e2e/diagnostic.md"), false);
  assert.equal(isSyncablePath("Personal/data.jsonl"), false);
  assert.equal(isSyncablePath("Personal/README.MD"), false);
});

test("embedding input is bounded without changing stored note content", () => {
  const short = "short note";
  const long = "x".repeat(20_000);

  assert.equal(embeddingInput(short), short);
  assert.equal(embeddingInput(long).length, 4_000);
  assert.equal(embeddingInput(long), long.slice(0, 4_000));
  assert.equal(long.length, 20_000);
});

test("case-insensitive path conflicts are detected without matching the same path", () => {
  const paths = ["Personal/Projects/Sentinel/Todo.md", "Other.md"];

  assert.equal(
    findCaseInsensitivePathConflict("Personal/Projects/Sentinel/TODO.md", paths),
    "Personal/Projects/Sentinel/Todo.md",
  );
  assert.equal(findCaseInsensitivePathConflict("Personal/Projects/Sentinel/Todo.md", paths), undefined);
  assert.equal(findCaseInsensitivePathConflict("Missing.md", paths), undefined);
});

test("recreating a path invalidates an older delete retry", () => {
  const generations = new PathGeneration();
  const deleteGeneration = generations.next("Recipes/pasta.md");
  assert.equal(generations.isCurrent("Recipes/pasta.md", deleteGeneration), true);

  generations.next("Recipes/pasta.md");

  assert.equal(generations.isCurrent("Recipes/pasta.md", deleteGeneration), false);
});

test("remote apply events are guarded only for the affected path", async () => {
  const guard = new RemoteChangeGuard();

  await guard.run("phone.md", async () => {
    assert.equal(guard.has("phone.md"), true);
    assert.equal(guard.has("desktop.md"), false);
  });

  assert.equal(guard.has("phone.md"), false);
});

test("each remote operation suppresses exactly one delayed vault event", () => {
  const suppressor = new RemoteEventSuppressor();
  suppressor.prepare("phone.md");

  assert.equal(suppressor.consume("desktop.md"), false);
  assert.equal(suppressor.consume("phone.md"), true);
  assert.equal(suppressor.consume("phone.md"), false);
});

test("a delayed remote event is suppressed only while content is unchanged", () => {
  const guard = new RemoteContentGuard();
  guard.prepare("phone.md", "pulled");
  assert.equal(guard.consumeIfMatching("phone.md", "pulled"), true);
  assert.equal(guard.consumeIfMatching("phone.md", "pulled"), true);

  assert.equal(guard.consumeIfMatching("phone.md", "user edit"), false);
  assert.equal(guard.consumeIfMatching("phone.md", "pulled"), false);
});

test("revision pages use a bounded keyset instead of a mutable offset", () => {
  const query = revisionPageQuery(100, 200, 100);

  assert.match(query, /sync_revision=gt\.100/);
  assert.match(query, /sync_revision=lte\.200/);
  assert.match(query, /order=sync_revision\.asc/);
  assert.doesNotMatch(query, /offset=/);
});

test("a concurrent update cannot make keyset paging skip the next revision", async () => {
  let revisions = Array.from({ length: 201 }, (_, index) => index + 1);
  let pageCount = 0;
  const fetchPage = async (after: number, highWater: number, limit: number) => {
    const page = revisions
      .filter((revision) => revision > after && revision <= highWater)
      .slice(0, limit)
      .map((syncRevision) => ({ syncRevision }));
    if (pageCount++ === 0) revisions = revisions.filter((revision) => revision !== 1).concat(202);
    return page;
  };

  const firstPull = await collectRevisionPages(0, 201, 100, fetchPage);
  assert.equal(firstPull.some((row) => row.syncRevision === 101), true);
  assert.equal(firstPull.at(-1)?.syncRevision, 201);

  const nextPull = await collectRevisionPages(201, 202, 100, fetchPage);
  assert.deepEqual(nextPull.map((row) => row.syncRevision), [202]);
});
