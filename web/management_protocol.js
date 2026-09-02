"use strict";

export const MGMT_FLAG_ERROR = 1 << 1;

export class ManagementResponseTracker {
  constructor(timeoutMs = 10000) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  wait(requestId) {
    if (this.pending.has(requestId)) {
      throw new Error(`Management request ${requestId} is already pending`);
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      rejectPromise(new Error(`Management response timed out (#${requestId})`));
    }, this.timeoutMs);

    this.pending.set(requestId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
    return promise;
  }

  settle(message) {
    if (message.type !== 2) {
      return false;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return false;
    }

    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    const text = message.text?.trim() || "";
    if ((message.flags & MGMT_FLAG_ERROR) !== 0 || /^ERR(?:\s|$)/.test(text)) {
      pending.reject(
        new Error(text || `Management request ${message.requestId} failed`),
      );
    } else {
      pending.resolve(message);
    }
    return true;
  }

  reject(requestId, error) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
    return true;
  }

  rejectAll(error) {
    for (const requestId of this.pending.keys()) {
      this.reject(requestId, error);
    }
  }
}
