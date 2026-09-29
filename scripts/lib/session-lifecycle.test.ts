import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext } from "playwright-core";
import { runPersistentSession } from "./session-lifecycle.ts";

test("successful action waits for graceful context.close before session resolves", async () => {
  const events: string[] = [];
  let finishClose: (() => void) | undefined;
  let completed = false;
  const context = {
    once: () => {},
    close: async () => {
      events.push("close-started");
      await new Promise<void>((resolve) => { finishClose = resolve; });
      events.push("close-finished");
    },
  } as unknown as BrowserContext;
  const pending = runPersistentSession(async () => context, async () => { events.push("verified"); })
    .then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["verified", "close-started"]);
  assert.equal(completed, false);
  assert.ok(finishClose);
  finishClose();
  await pending;
  assert.equal(completed, true);
  assert.deepEqual(events, ["verified", "close-started", "close-finished"]);
});

test("action failure still closes the context exactly once", async () => {
  let closes = 0;
  const context = { once: () => {}, close: async () => { closes++; } } as unknown as BrowserContext;
  await assert.rejects(runPersistentSession(async () => context, async () => { throw new Error("fixture"); }));
  assert.equal(closes, 1);
});

test("failed graceful close rejects instead of reporting completed success", async () => {
  const context = { once: () => {}, close: async () => { throw new Error("fixture"); } } as unknown as BrowserContext;
  await assert.rejects(runPersistentSession(async () => context, async () => {}));
});
