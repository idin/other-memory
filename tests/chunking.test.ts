import { describe, expect, test } from "vitest";

import {
  chunkFile,
  chunkSearchText,
  estimateTokens,
  stripSuperseded,
  type MemoryChunk,
} from "../src/chunking";
import type { StoreFile } from "../src/store_checks";

/**
 * These are the acceptance criteria for search, not incidental unit tests.
 *
 * Every fixture below is real content from the store, quoted rather than
 * invented, because each represents a way this store differs from generic
 * markdown — and each would silently corrupt results if chunking got it wrong.
 * A test against a tidy invented document would pass while the real store
 * broke.
 */

function file(path: string, text: string): StoreFile {
  return { path, text, bytes: text.length };
}

function chunkContaining(chunks: MemoryChunk[], needle: string): MemoryChunk {
  const found = chunks.find((chunk) => chunk.text.includes(needle));
  if (!found) {
    throw new Error(
      `No chunk contains "${needle}". Chunks were: `
        + chunks.map((chunk) => chunk.text.slice(0, 40)).join(" | "),
    );
  }
  return found;
}

/** Real, from facts/core.md — an H3 nested under a provenance H2. */
const CORE_FACTS = `# Core

Identity, communication style. Filled in over time via the
\`save-to-memory\` skill as facts are stated in conversation — see
[instructions.md](../instructions.md) for the rules (only stated facts, never inferred).

## Imported 2026-08-08 from a ChatGPT summary (second-hand)

Provenance: Idin asked ChatGPT what it knew about him, pasted the result,
and asked for it to be added here. These are not his verbatim statements,
so treat them as lower confidence than facts stated directly in
conversation.

- Name: Idin, pronounced "eye-din".
- Born 1980-07-02. ~~Mid-40s.~~ — superseded 2026-08-10: Idin stated the
  date directly. Never write his age down; derive it with \`describe_age\`.
- Has a toy poodle named Frodo, who matters a lot to him. ~~13-year-old
  light-brown~~ — superseded 2026-08-09 by facts Idin stated directly:
  born 2013-05-06, and "red" rather than light-brown.

### Money

- Sold a Vancouver condo. The proceeds are in cash.
- Prefers to understand a fee before agreeing to it.

### Entertainment and hobbies

- Watches science fiction.

## Assistant names (stated directly, 2026-08-08)

- The memory agent is called Ada.
- The research agent is called Kip.
`;

describe("stripSuperseded", () => {
  test("the struck value leaves the searchable text", () => {
    // Idin's age is the canonical case: "Mid-40s" is retained in the file by
    // instruction, and must not be retrievable as a current fact.
    const { current, superseded } = stripSuperseded(
      "Born 1980-07-02. ~~Mid-40s.~~ — superseded 2026-08-10",
    );
    expect(current).not.toContain("Mid-40s");
    expect(superseded).toEqual(["Mid-40s."]);
  });

  test("the correction around it survives", () => {
    const { current } = stripSuperseded(
      "Born 1980-07-02. ~~Mid-40s.~~ — superseded 2026-08-10",
    );
    expect(current).toContain("Born 1980-07-02");
    expect(current).toContain("superseded 2026-08-10");
  });

  test("a strikethrough spanning lines is handled", () => {
    // Real: Frodo's colour wraps across a line break in core.md.
    const { current, superseded } = stripSuperseded(
      "Has a toy poodle named Frodo. ~~13-year-old\nlight-brown~~ — superseded",
    );
    expect(current).not.toContain("light-brown");
    expect(superseded[0]).toContain("13-year-old");
  });

  test("several in one passage are all caught", () => {
    const { superseded } = stripSuperseded("~~one~~ and ~~two~~ and ~~three~~");
    expect(superseded).toEqual(["one", "two", "three"]);
  });

  test("text without strikethrough is returned unchanged", () => {
    expect(stripSuperseded("plain text").current).toBe("plain text");
    expect(stripSuperseded("plain text").superseded).toEqual([]);
  });
});

describe("provenance travels with the chunk", () => {
  const chunks = chunkFile(file("other-memory/facts/core.md", CORE_FACTS));

  test("an H3 under a provenance H2 keeps the second-hand marker", () => {
    // The most important test here. "Sold a Vancouver condo" is second-hand,
    // and a chunk carrying only its own "Money" heading would present it with
    // the same confidence as a directly stated fact.
    const money = chunkContaining(chunks, "Sold a Vancouver condo");
    expect(money.headingPath.join(" ")).toContain("second-hand");
    expect(money.headingPath).toContain("Money");
  });

  test("the marker reaches the searchable text, not just the metadata", () => {
    const money = chunkContaining(chunks, "Sold a Vancouver condo");
    expect(chunkSearchText(money)).toContain("second-hand");
  });

  test("a directly stated section does not inherit it", () => {
    // The guard against over-inheriting: Ada's name is stated directly and
    // must not be tagged second-hand by a chunker that got the stack wrong.
    const names = chunkContaining(chunks, "memory agent is called Ada");
    expect(names.headingPath.join(" ")).not.toContain("second-hand");
  });

  test("the file preamble reaches every chunk", () => {
    // "only stated facts, never inferred" scopes the whole file.
    for (const chunk of chunks) {
      expect(chunk.filePreamble).toContain("never inferred");
    }
  });

  test("the preamble is not itself a chunk", () => {
    expect(chunks.some((chunk) => chunk.text.startsWith("Identity,"))).toBe(
      false,
    );
  });

  test("superseded values do not survive into any chunk", () => {
    for (const chunk of chunks.filter((one) => !one.containsSuperseded)) {
      expect(chunk.text).not.toContain("Mid-40s");
      expect(chunk.text).not.toContain("13-year-old");
    }
  });

  test("but the correction explaining them does survive", () => {
    // The distinction that matters: "light-brown" appears twice in this file,
    // once inside the strikethrough and once in the correction that says the
    // colour is "red" rather than light-brown. Removing the struck span must
    // not remove the sentence explaining why it was struck — a rule forbidding
    // the word outright would delete the correction along with the error.
    const frodo = chunkContaining(chunks, "toy poodle named Frodo");
    expect(frodo.text).toContain('"red" rather than light-brown');
    expect(frodo.superseded.join(" ")).toContain("13-year-old");
  });
});

describe("yaml keeps the comments that carry corrections", () => {
  /** Real, from facts/inventory.yaml — the correction is comment-only. */
  const INVENTORY = `items:
  - name: television, 65 inch
    category: electronics
    make: Samsung

  - name: LG OLED B5 55 inch
    category: electronics
    make: LG
    note: >-
      Which room it is in was not stated. Idin has three TVs as of
      2026-08-13.

  # Correction appended 2026-08-13, stated directly by Idin. Supersedes the
  # "Which room it is in was not stated" note on the LG OLED entry above.
  #
  # The LG OLED B5 55" is in the second floor office, bought for gaming.
`;

  const chunks = chunkFile(file("other-memory/facts/inventory.yaml", INVENTORY));

  test("the correction is not dropped", () => {
    // A YAML parser drops comments, which would keep the superseded note and
    // lose the thing that corrects it.
    const all = chunks.map((chunk) => chunk.text).join("\n");
    expect(all).toContain("second floor office");
  });

  test("the correction stays with the entry it corrects", () => {
    const oled = chunkContaining(chunks, "LG OLED B5");
    expect(oled.text).toContain("second floor office");
  });

  test("separate items are separate chunks", () => {
    expect(chunks.length).toBeGreaterThan(1);
    const samsung = chunkContaining(chunks, "Samsung");
    expect(samsung.text).not.toContain("LG OLED");
  });
});

describe("messages", () => {
  const MESSAGE = `---
from: kip
to: ada
subject: No picker exists — and the memory layout has moved
sent_at: 2026-08-09T17:15:00.000Z
---

There is no picker. I checked the worker source and the tool list.

The layout moved on 2026-08-09, so the paths in your note are stale.
`;

  const chunks = chunkFile(
    file(
      "other-memory/messages/inbox/ada/2026-08-09T17-15_kip_no_picker.md",
      MESSAGE,
    ),
  );

  test("correspondence is flagged as such", () => {
    // messages_are_not_memory.md exists as an instruction; this makes it
    // mechanically enforceable rather than something an agent must remember.
    expect(chunks.every((chunk) => chunk.isMessage)).toBe(true);
  });

  test("the frontmatter is context, not body", () => {
    expect(chunks[0].text).not.toContain("sent_at:");
    expect(chunks[0].filePreamble).toContain("from: kip");
  });

  test("the subject is searchable", () => {
    expect(chunkSearchText(chunks[0])).toContain("No picker exists");
  });
});

describe("short files stay whole", () => {
  const MISTAKE = `# Argued a cap needed protecting from the wrong thing

Argued that the subfolder escape had to be closed or the cap would be
meaningless. That treated the cap as a limit on file size. It is a limit on
how many rules an agent may author for itself.

Caught by Ada, prompted by Idin raising organization. Pattern: inherited a
rule's stated rationale instead of working out its actual function.

Recorded 2026-08-12.
`;

  test("a short entry is one chunk", () => {
    // Splitting the pattern from the error it generalises leaves two chunks
    // that each mean less than the whole.
    const chunks = chunkFile(
      file("other-memory/guidance/mistakes/2026-08-12_argued_a_cap.md", MISTAKE),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Pattern:");
    expect(chunks[0].text).toContain("subfolder escape");
  });

  test("it still carries its title", () => {
    const chunks = chunkFile(
      file("other-memory/guidance/mistakes/2026-08-12_argued_a_cap.md", MISTAKE),
    );
    expect(chunks[0].headingPath).toEqual([
      "Argued a cap needed protecting from the wrong thing",
    ]);
  });
});

describe("the token ceiling is never exceeded", () => {
  test("a long section is split rather than truncated", () => {
    // Silent truncation is the model's behaviour above 512 tokens, and the
    // failure mode this whole design avoids.
    const long = `# Long\n\nPreamble.\n\n## Section\n\n${"word ".repeat(4000)}`;
    const chunks = chunkFile(file("other-memory/facts/long.md", long));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunkSearchText(chunk))).toBeLessThan(
        512,
      );
    }
  });

  test("a long preamble is charged against the body's budget", () => {
    // The bug this caught, found by running the chunker over the real store
    // rather than fixtures: the target was measured against the chunk body
    // alone, but the heading path and preamble are prepended before
    // embedding. Two real files produced chunks of 521 and 616 tokens, both
    // of which the model would have truncated silently.
    const preamble = "Provenance and scope. ".repeat(60);
    const body = "A sentence about storage. ".repeat(60);
    const chunks = chunkFile(
      file(
        "other-memory/facts/wordy.md",
        `# Wordy\n\n${preamble}\n\n## A section\n\n${body}\n\n## Another\n\n${body}`,
      ),
    );
    for (const chunk of chunks) {
      expect(estimateTokens(chunkSearchText(chunk))).toBeLessThanOrEqual(512);
    }
  });

  test("a hard split overlaps so a boundary-spanning phrase survives", () => {
    const sentences = Array.from(
      { length: 200 },
      (_unused, index) => `Sentence number ${index} about storage.`,
    ).join(" ");
    const chunks = chunkFile(
      file("other-memory/facts/long.md", `# Long\n\nPreamble.\n\n## S\n\n${sentences}`),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.text.includes("Sentence number 99"))).toBe(
      true,
    );
  });
});

describe("chunk identity", () => {
  test("chunking is deterministic", () => {
    const first = chunkFile(file("other-memory/facts/core.md", CORE_FACTS));
    const second = chunkFile(file("other-memory/facts/core.md", CORE_FACTS));
    expect(second).toEqual(first);
  });

  test("ordinals are unique within a file", () => {
    const chunks = chunkFile(file("other-memory/facts/core.md", CORE_FACTS));
    const ordinals = chunks.map((chunk) => chunk.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  test("resolved work is marked deep", () => {
    const chunks = chunkFile(
      file("other-memory/work/todos/resolved/2026-08-12_done.md", "# Done\n\nIt was finished.\n"),
    );
    expect(chunks[0].isDeep).toBe(true);
  });

  test("current facts are not", () => {
    const chunks = chunkFile(file("other-memory/facts/core.md", CORE_FACTS));
    expect(chunks.every((chunk) => !chunk.isDeep)).toBe(true);
  });
});
