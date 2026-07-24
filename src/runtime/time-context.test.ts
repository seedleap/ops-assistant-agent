import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestTimeContext, isValidTimeZone } from "./time-context.js";

test("request time context uses an explicit IANA timezone", () => {
  const context = buildRequestTimeContext(
    "2026-07-24T04:30:00.000Z",
    "Asia/Hong_Kong",
    "America/Los_Angeles",
  );
  assert.equal(context.current_time_utc, "2026-07-24T04:30:00.000Z");
  assert.equal(context.timezone, "Asia/Hong_Kong");
  assert.equal(context.timezone_source, "request");
  assert.match(context.local_time, /2026-07-24/);
  assert.match(context.local_time, /12:30:00/);
});

test("request time context falls back from memory to UTC", () => {
  assert.equal(buildRequestTimeContext("2026-07-24T04:30:00.000Z", undefined, "Asia/Tokyo").timezone_source, "memory");
  const fallback = buildRequestTimeContext("2026-07-24T04:30:00.000Z");
  assert.equal(fallback.timezone, "UTC");
  assert.equal(fallback.timezone_source, "default");
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
});
