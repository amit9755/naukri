import type { BrowserContext } from "playwright-core";

// One graceful close promise, awaited even after cancellation or action failure.
export async function runPersistentSession(
  launch: () => Promise<BrowserContext>,
  action: (context: BrowserContext, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  let context: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const close = () => context ? (closing ??= context.close()) : Promise.resolve();
  const stop = () => {
    process.exitCode = 130;
    controller.abort();
    void close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    context = await launch();
    context.once("close", () => controller.abort());
    if (!controller.signal.aborted) await action(context, controller.signal);
  } finally {
    try {
      await close();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
