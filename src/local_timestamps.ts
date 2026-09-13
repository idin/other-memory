/**
 * UTC timestamps are rewritten to Idin's timezone before an agent sees them.
 *
 * An agent reading `2026-09-11T19:05:44Z` and reporting "19:05" to someone in
 * Toronto is wrong by four hours, and nothing in the string says so. That
 * happened: an email that arrived at 3:05pm was reported as 7pm, and an event
 * from the previous afternoon was described as "about two hours ago". Being
 * asked whether you are gaslighting someone is the cost of stating a derived
 * time confidently and wrongly twice in one conversation.
 *
 * The fix is not a rule telling agents to convert. That rule existed as prose
 * and did not work. Instead the raw UTC value never reaches the agent, so it
 * cannot be misread — the same shape as deriving a path rather than letting a
 * caller supply one. Enforcement lives in code, not in judgement.
 */

/**
 * Where Idin is. Timestamps are rendered here because he is the person reading
 * every answer that comes out of this server.
 *
 * Not a user-specific value smuggled in as a constant: this server has exactly
 * one user, and a timestamp rendered in any other zone would be wrong for the
 * only person who will read it.
 */
const DISPLAY_TIME_ZONE = "America/Toronto";

/**
 * Matches an ISO-8601 instant in UTC: `2026-09-11T19:05:44Z`, with optional
 * fractional seconds, and `+00:00` as the other spelling of the same thing.
 *
 * Deliberately does NOT match offsets other than UTC. A timestamp that already
 * carries `-04:00` has been localised by whoever produced it, and rewriting it
 * would be second-guessing a decision already made correctly.
 *
 * Deliberately does NOT match a bare date (`2026-09-11`). A date with no time
 * has no instant to convert, and shifting it by an offset would change the day
 * for no reason — the exact bug this module exists to prevent, inverted.
 */
const UTC_INSTANT_PATTERN =
  /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|\+00:00)\b/g;

/**
 * Render one UTC instant in the display timezone, keeping the offset visible.
 *
 * The offset stays in the output so the value is still unambiguous. A reader
 * who needs to compare it against something in another zone can; a reader who
 * just wants to know what time it was does not have to do arithmetic.
 *
 * @param isoInstant - An ISO-8601 instant, e.g. `2026-09-11T19:05:44Z`.
 * @returns The same instant in the display timezone, e.g.
 *   `2026-09-11 15:05:44 EDT`. Returns the input unchanged if it does not
 *   parse, because a timestamp this function cannot read is one it must not
 *   silently corrupt.
 */
export function convertInstantToDisplayZone(isoInstant: string): string {
  const parsed = new Date(isoInstant);
  if (Number.isNaN(parsed.getTime())) {
    return isoInstant;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const parts = new Map(formatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  const date = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const time = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;

  return `${date} ${time} ${parts.get("timeZoneName")}`;
}

/**
 * Rewrite every UTC instant in a block of text into the display timezone.
 *
 * Applied to whole tool responses rather than to individual fields, because
 * timestamps arrive embedded in prose, in JSON, in commit messages and in
 * file content — anywhere a string can go. Enumerating the places would mean
 * enumerating them again for every tool added later.
 *
 * @param text - Any text on its way to an agent.
 * @returns The same text with UTC instants localised.
 */
export function localiseTimestampsInText(text: string): string {
  return text.replace(UTC_INSTANT_PATTERN, (match) => convertInstantToDisplayZone(match));
}

/**
 * Rewrite UTC instants anywhere inside a tool's response value.
 *
 * Walks strings, arrays and plain objects. Anything else — numbers, booleans,
 * null, class instances — is returned untouched, since a timestamp that is not
 * a string is not the failure this guards against.
 *
 * @param value - A tool's return value, of any shape.
 * @returns The value with every UTC instant inside it localised.
 */
export function localiseTimestamps(value: unknown): unknown {
  if (typeof value === "string") {
    return localiseTimestampsInText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => localiseTimestamps(entry));
  }

  if (value !== null && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, localiseTimestamps(entry)]),
    );
  }

  return value;
}
