import { test, expect } from "@playwright/test";

/* Android WebView below Chrome 100 lacks AbortSignal.prototype.throwIfAborted
 * (Chrome 100), AbortSignal.timeout (103) and AbortSignal.any (116). Every abort
 * check in this app calls throwIfAborted(), so on such a WebView the automatic
 * reconnect died with "n?.throwIfAborted is not a function" before it could
 * dial. index.html backfills all three ahead of every module; these tests delete
 * the native methods first, so the backfill is what answers. */
const stripNative = () => {
  delete AbortSignal.prototype.throwIfAborted;
  delete AbortSignal.timeout;
  delete AbortSignal.any;
};

test("the page backfills AbortSignal for a WebView that lacks it", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.goto("/?demo=board");
  const api = await page.evaluate(() => ({
    throwIfAborted: typeof AbortSignal.prototype.throwIfAborted,
    timeout: typeof AbortSignal.timeout,
    any: typeof AbortSignal.any,
  }));
  expect(api).toEqual({ throwIfAborted: "function", timeout: "function", any: "function" });
});

test("the backfilled AbortSignal behaves like the native one", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.goto("/?demo=board");
  const observed = await page.evaluate(async () => {
    // A signal that was never aborted returns quietly.
    new AbortController().signal.throwIfAborted();

    // An aborted signal throws its own reason instead of a generic AbortError.
    const aborted = AbortSignal.abort(new Error("the link went away"));
    let reason = "did not throw";
    try { aborted.throwIfAborted(); } catch (error) { reason = error.message; }

    // any() follows the first signal that aborts, and keeps its reason.
    const either = AbortSignal.any([new AbortController().signal, aborted]);
    // …and stays quiet while none of its inputs has aborted. Created here, before
    // `timed` fires, so this one cannot inherit that abort.
    const quiet = AbortSignal.any([new AbortController().signal, new AbortController().signal]);

    // timeout() settles with a TimeoutError after the delay, not before it.
    const started = Date.now();
    const timed = AbortSignal.timeout(30);
    const timeoutName = await new Promise((resolve) => {
      timed.addEventListener("abort", () => resolve(timed.reason?.name ?? "no reason"), { once: true });
    });

    return {
      reason,
      timeoutName,
      waited: Date.now() - started >= 25,
      eitherAborted: either.aborted,
      sameReason: either.reason === aborted.reason,
      quietAborted: quiet.aborted,
    };
  });
  expect(observed).toEqual({
    reason: "the link went away",
    timeoutName: "TimeoutError",
    waited: true,
    eitherAborted: true,
    sameReason: true,
    quietAborted: false,
  });
});

test("an aborted signal from the backfill stops work that checks it", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.goto("/?demo=board");
  const stopped = await page.evaluate(async () => {
    const controller = new AbortController();
    const seen = [];
    const work = (async () => {
      try {
        for (let step = 0; step < 5; step++) {
          controller.signal.throwIfAborted();
          seen.push(step);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return "finished";
      } catch (error) {
        return error.name;
      }
    })();
    setTimeout(() => controller.abort(), 12);
    return { outcome: await work, steps: seen.length };
  });
  expect(stopped.outcome).toBe("AbortError");
  expect(stopped.steps).toBeLessThan(5);
});
