import { describe, expect, test } from "vitest";

import {
  convertInstantToDisplayZone,
  localiseTimestamps,
  localiseTimestampsInText,
} from "../src/local_timestamps";

/**
 * A check tested against one case is not tested. The failure this guards
 * against is a mismatch between two zones, so each block below covers the
 * pass, the genuine fail, and the confusable near-miss that a happy-path
 * test would wave through.
 *
 * The near-misses matter most here: a timestamp that is already localised,
 * and a bare date with no instant in it. Rewriting either would be a new bug
 * introduced by the fix for the old one.
 */

describe("convertInstantToDisplayZone", () => {
  test("converts the timestamp from the incident that prompted this", () => {
    // Reported to Idin as "19:05" and then as roughly 7pm. Toronto was
    // UTC-4 that day; the email actually arrived at 3:05pm.
    expect(convertInstantToDisplayZone("2026-09-11T19:05:44Z")).toBe(
      "2026-09-11 15:05:44 EDT",
    );
  });

  test("uses standard time outside daylight saving", () => {
    // January is EST (UTC-5), so the same clock time shifts by five hours.
    expect(convertInstantToDisplayZone("2026-01-15T19:05:44Z")).toBe(
      "2026-01-15 14:05:44 EST",
    );
  });

  test("rolls back to the previous day when UTC has already advanced", () => {
    // 00:30 UTC is still the evening before in Toronto. An agent reading the
    // raw value would report the wrong date, not merely the wrong hour.
    expect(convertInstantToDisplayZone("2026-09-12T00:30:00Z")).toBe(
      "2026-09-11 20:30:00 EDT",
    );
  });

  test("returns unparseable input unchanged rather than corrupting it", () => {
    expect(convertInstantToDisplayZone("not-a-timestamp")).toBe("not-a-timestamp");
  });
});

describe("localiseTimestampsInText", () => {
  test("rewrites a timestamp embedded in prose", () => {
    expect(localiseTimestampsInText("Message received at 2026-09-11T19:05:44Z from Martin.")).toBe(
      "Message received at 2026-09-11 15:05:44 EDT from Martin.",
    );
  });

  test("rewrites every timestamp, not only the first", () => {
    const rewritten = localiseTimestampsInText(
      "created 2026-09-11T19:05:44Z, updated 2026-09-12T00:30:00Z",
    );
    expect(rewritten).toBe(
      "created 2026-09-11 15:05:44 EDT, updated 2026-09-11 20:30:00 EDT",
    );
  });

  test("accepts +00:00 as the other spelling of UTC", () => {
    expect(localiseTimestampsInText("at 2026-09-11T19:05:44+00:00")).toBe(
      "at 2026-09-11 15:05:44 EDT",
    );
  });

  test("leaves a bare date alone — there is no instant to convert", () => {
    // The near-miss. Shifting a date with no time would change the day for
    // no reason, which is the original bug inverted.
    expect(localiseTimestampsInText("recorded 2026-09-11 in the log")).toBe(
      "recorded 2026-09-11 in the log",
    );
  });

  test("leaves an already-localised timestamp alone", () => {
    // The other near-miss. A value carrying -04:00 was localised by whoever
    // produced it; rewriting it would second-guess a correct decision.
    expect(localiseTimestampsInText("at 2026-09-11T15:05:44-04:00")).toBe(
      "at 2026-09-11T15:05:44-04:00",
    );
  });

  test("leaves text with no timestamps untouched", () => {
    expect(localiseTimestampsInText("no times here at all")).toBe("no times here at all");
  });
});

describe("localiseTimestamps", () => {
  test("rewrites timestamps nested in objects and arrays", () => {
    expect(
      localiseTimestamps({
        commits: [{ message: "fix", date: "2026-09-11T19:05:44Z" }],
        checked: "2026-09-12T00:30:00Z",
      }),
    ).toEqual({
      commits: [{ message: "fix", date: "2026-09-11 15:05:44 EDT" }],
      checked: "2026-09-11 20:30:00 EDT",
    });
  });

  test("leaves non-string values as they are", () => {
    expect(localiseTimestamps({ count: 3, ok: true, missing: null })).toEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });
});
