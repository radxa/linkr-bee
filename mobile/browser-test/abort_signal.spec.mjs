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

test("pre-98 controllers preserve the first reason during dispatch and through composition", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.addInitScript(() => {
    delete AbortSignal.prototype.reason;
    const nativeAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function () { nativeAbort.call(this); };
    // Chrome 93–97 exposed this factory but ignored the reason.
    const nativeFactory = AbortSignal.abort;
    AbortSignal.abort = () => nativeFactory();
  });
  await page.goto("/?demo=board");
  const observed = await page.evaluate(async () => {
    const timed = AbortSignal.timeout(1);
    const combined = AbortSignal.any(new Set([timed]));
    const during = await new Promise(resolve => {
      combined.addEventListener("abort", () => resolve(combined.reason), { once: true });
    });
    const controller = new AbortController();
    controller.abort(null);
    controller.abort("second reason");
    const explicit = new Error("disconnected");
    let thrown;
    try { combined.throwIfAborted(); } catch (error) { thrown = error; }
    return {
      name: during.name,
      identity: during === timed.reason && thrown === during,
      firstReason: controller.signal.reason,
      factory: AbortSignal.abort(explicit).reason === explicit,
      defaultName: AbortSignal.abort().reason.name,
    };
  });
  expect(observed).toEqual({ name: "TimeoutError", identity: true, firstReason: null, factory: true, defaultName: "AbortError" });
});

test("any validates iterators and releases all listeners when a child aborts", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.goto("/?demo=board");
  const result = await page.evaluate(() => {
    const parent = new AbortController().signal;
    const listeners = new Set();
    const add = parent.addEventListener.bind(parent);
    const remove = parent.removeEventListener.bind(parent);
    parent.addEventListener = (type, fn, options) => { listeners.add(fn); add(type, fn, options); };
    parent.removeEventListener = (type, fn, options) => { listeners.delete(fn); remove(type, fn, options); };
    const child = new AbortController();
    function* inputs() { yield parent; yield child.signal; yield parent; }
    const combined = AbortSignal.any(inputs());
    const attached = listeners.size;
    child.abort("retired");
    let invalid;
    try { AbortSignal.any([parent, child.signal, {}]); } catch (error) { invalid = error.name; }
    return { attached, remaining: listeners.size, reason: combined.reason, invalid };
  });
  expect(result).toEqual({ attached: 1, remaining: 0, reason: "retired", invalid: "TypeError" });
});

test("long timeouts use bounded timer chunks and expire after the last one", async ({ page }) => {
  await page.addInitScript(stripNative);
  await page.goto("/?demo=board");
  const observed = await page.evaluate(() => {
    const timers = [];
    const delays = [];
    const nativeTimer = window.setTimeout;
    window.setTimeout = (cb, ms) => { timers.push(cb); delays.push(ms); return timers.length; };
    try {
      const signal = AbortSignal.timeout(2 ** 31);
      timers.shift()();
      const afterFirst = signal.aborted;
      timers.shift()();
      return { delays, afterFirst, reason: signal.reason.name };
    } finally {
      window.setTimeout = nativeTimer;
    }
  });
  expect(observed).toEqual({ delays: [2147483647, 1], afterFirst: false, reason: "TimeoutError" });
});
