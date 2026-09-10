/**
 * Splitting store files into retrievable units.
 *
 * The file is not the unit of retrieval. `facts/core.md` holds seven unrelated
 * subjects, so scoring it as one blob dilutes a match against 120 lines of
 * text about something else, and answering "core.md matched" says almost
 * nothing about what matched.
 *
 * Three properties of this store make naive chunking wrong, and each is a
 * correctness requirement rather than a refinement:
 *
 * 1. Superseded facts are struck through and kept, by instruction. A chunker
 *    that indexes them will return Idin's wrong age and Frodo's wrong colour
 *    as current.
 * 2. Provenance lives in ancestor headings. `### Money` sits under
 *    `## Imported ... (second-hand)`, so a chunk that carries only its
 *    immediate heading has lost the fact that it is second-hand.
 * 3. `inventory.yaml` carries a correction that exists only as a comment.
 *    Parsing it as YAML drops the correction and keeps the superseded note.
 *
 * Everything here is pure: text in, chunks out. No network, no storage.
 */

import { ARCHIVE_PREFIX, INBOX_PREFIX } from "./layout";
import { isDeep } from "./deep_memory";
import type { StoreFile } from "./store_checks";

/**
 * The token ceiling of the embedding model.
 *
 * `@cf/baai/bge-base-en-v1.5` accepts 512 input tokens and **silently
 * truncates** above that — no error, and the tail is simply not embedded. A
 * chunk that exceeds this must be split rather than sent, so this is exported
 * for the assertion at the embedding call site.
 */
export const EMBEDDING_MODEL_TOKEN_LIMIT = 512;

/**
 * Characters per token, for estimating length without a tokenizer.
 *
 * No BPE tokenizer is available in a Worker, so length is estimated from
 * character count. Four characters per token is the standard approximation for
 * English prose; YAML and path-heavy text tokenize worse than that, which is
 * why the target below leaves room rather than treating this as exact.
 */
const CHARACTERS_PER_TOKEN_ESTIMATE = 4;

/**
 * What a chunk aims for, in estimated tokens.
 *
 * Derived rather than chosen: the model's limit is 512, the heading path and
 * file preamble are prepended to every chunk and can run to 60 tokens on the
 * deepest headings in this store, and the character-count estimate above is
 * approximate in the unsafe direction for non-prose. 320 leaves room for all
 * three and still holds a long section whole.
 */
const CHUNK_TARGET_TOKENS = 320;

/**
 * The largest the file preamble may be, in estimated tokens.
 *
 * The preamble is prepended to every chunk's embedded text, so its cost is
 * paid once per chunk. A scope note — "these figures are second-hand", "as of
 * September 2026" — is a sentence or two and fits easily. But nothing stops a
 * file putting a hundred lines of content before its first `##`, and when it
 * does, `splitMarkdown` was classifying the whole block as preamble and
 * welding it onto every chunk. `gmail_filters.md` did exactly this on
 * 2026-09-08 and every chunk blew past the model's limit, which failed the
 * entire search.
 *
 * Half the chunk target: a preamble larger than the body it qualifies has
 * stopped being a qualifier. Content beyond this is emitted as its own chunk
 * under the H1 instead, and chunked like any other section.
 */
const MAXIMUM_PREAMBLE_TOKENS = CHUNK_TARGET_TOKENS / 2;

/**
 * The line count below which a file with no internal sections is one chunk.
 *
 * Two conditions, not one. Length alone is the wrong test: a thirty-line file
 * with four `##` sections is four things, and a ninety-line mistake with
 * no headings at all is one. So this applies only to files that have no
 * heading below the title — where there is nothing to split on that the author
 * put there.
 *
 * The number derives from the store's own layout rule, which says a file
 * becomes a folder past roughly 100 lines. A file below that with no sections
 * is one argument: a mistake's "Pattern:" paragraph is meaningless split
 * from the error it generalises, and an instruction's rationale is meaningless
 * split from the rule.
 */
const WHOLE_FILE_LINE_LIMIT = 100;

/**
 * The shortest a chunk may be after stripping superseded spans.
 *
 * Below this, stripping has removed so much that what remains cannot stand on
 * its own — the strikethrough was the subject of the sentence rather than a
 * corrected value inside it. Such a chunk keeps its full text and is flagged
 * instead, so a detector exists for a case this cannot handle in general.
 */
const MINIMUM_MEANINGFUL_CHUNK_CHARACTERS = 24;

/** How much text overlaps when a chunk has to be split by force. */
const HARD_SPLIT_OVERLAP_CHARACTERS = 120;

/**
 * Openings that show a chunk depends on the one before it.
 *
 * "It went from Scotia to TD Bank" is meaningless alone: the subject is in the
 * previous chunk. Detecting this matters because embedding similarity does
 * not — that pair is about one subject while sharing almost no vocabulary, so
 * their vectors may sit far apart, and a similarity threshold would miss
 * exactly the case that needs catching while linking unrelated bullets that
 * happen to share dates and dollar amounts.
 *
 * A dangling reference is a textual fact, so it is detected textually.
 */
const DANGLING_REFERENCE_PATTERN =
  /^[-*\s]*(it|this|that|these|those|they|them|both|either|neither|such|the (above|former|latter|same))\b/i;

/** The blank lines joining heading path, preamble and body in search text. */
const PREAMBLE_JOIN_TOKENS = 2;

/**
 * The floor on body tokens, however large the preamble.
 *
 * A file with a preamble longer than the whole budget would otherwise drive
 * the available body size to zero or below, splitting forever. This bounds it:
 * such a chunk exceeds the target and is reported by the assertion at the
 * embedding call site rather than being split into fragments too small to
 * mean anything.
 */
const MINIMUM_BODY_TOKENS = 64;

export type MemoryChunk = {
  path: string;
  /** Position within the file. With path, this identifies the chunk. */
  ordinal: number;
  /** Every ancestor heading, outermost first, so provenance travels. */
  headingPath: string[];
  /** The un-headed paragraph after the H1, which scopes the whole file. */
  filePreamble: string;
  /** Searchable and embeddable text, with superseded spans removed. */
  text: string;
  /** What was struck through, kept so it remains findable when wanted. */
  superseded: string[];
  /** True when stripping would have gutted the text, so nothing was removed. */
  containsSuperseded: boolean;
  /**
   * True when this chunk opens with a reference to something before it.
   *
   * Retrieval uses this to pull in the preceding sibling, so a hit reading
   * "It went from Scotia to TD Bank" arrives with the sentence naming what
   * "it" is. Persisted because it is cheap to compute once and awkward to
   * recompute per query.
   */
  dependsOnPrevious: boolean;
  isMessage: boolean;
  isDeep: boolean;
  startLine: number;
  endLine: number;
};

/** Estimate token count from character count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN_ESTIMATE);
}

/**
 * Separate current text from superseded text.
 *
 * `~~...~~` spans are removed from what is searchable and returned separately.
 * They are not deleted: a deliberate search for a superseded value should
 * still find it, labelled as superseded. What must not happen is a search for
 * current facts returning them as though they were current.
 *
 * @param text - The text to split.
 * @returns The text without struck-through spans, and the spans.
 */
export function stripSuperseded(text: string): {
  current: string;
  superseded: string[];
} {
  const superseded: string[] = [];
  const current = text.replace(/~~(.+?)~~/gs, (_match, inner: string) => {
    superseded.push(inner.trim());
    return "";
  });
  return { current, superseded };
}

/**
 * Apply supersession stripping, backing out when it guts the text.
 *
 * The general case cannot be solved by removing spans: where the strikethrough
 * wraps a bullet's whole subject, what is left is a fragment. Rather than
 * pretend otherwise, this keeps the original text when stripping leaves too
 * little, and flags it so the caller knows the chunk mixes current and
 * superseded content.
 */
function applySupersession(text: string): {
  text: string;
  superseded: string[];
  containsSuperseded: boolean;
} {
  const { current, superseded } = stripSuperseded(text);
  if (superseded.length === 0) {
    return { text, superseded: [], containsSuperseded: false };
  }
  const tidied = current.replace(/[ \t]{2,}/g, " ").replace(/ +$/gm, "");
  if (tidied.trim().length < MINIMUM_MEANINGFUL_CHUNK_CHARACTERS) {
    return { text, superseded, containsSuperseded: true };
  }
  return { text: tidied, superseded, containsSuperseded: false };
}

/** Whether a path is correspondence rather than memory. */
function isMessagePath(path: string): boolean {
  return path.startsWith(INBOX_PREFIX) || path.startsWith(ARCHIVE_PREFIX);
}

type RawChunk = { text: string; headingPath: string[]; startLine: number };

/**
 * Split markdown on headings, carrying ancestry.
 *
 * A heading stack is maintained as the walk proceeds, so every chunk records
 * the full path from the H1 down. This is what makes provenance inheritance
 * automatic: `### Money` under `## Imported ... (second-hand)` carries the
 * second-hand marker without anyone enumerating which headings are provenance
 * headings and which are topics.
 */
function splitMarkdown(text: string): {
  preamble: string;
  chunks: RawChunk[];
} {
  const lines = text.split("\n");
  const stack: string[] = [];
  const chunks: RawChunk[] = [];
  let preamble = "";
  let buffer: string[] = [];
  let bufferHeadings: string[] = [];
  let bufferStart = 1;
  let seenHeading = false;

  function flush(endExclusive: number): void {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (body.length === 0) {
      return;
    }
    // Everything before the first H2 is the file's own scope note, which the
    // store's convention puts there to qualify every fact below it — but only
    // up to a point. A block larger than MAXIMUM_PREAMBLE_TOKENS is content,
    // not a qualifier, and welding it onto every chunk is what failed the
    // whole search on 2026-09-08. Keep the leading scope note as preamble and
    // emit the overflow as an ordinary chunk under the H1.
    if (bufferHeadings.length <= 1 && !seenHeading) {
      if (estimateTokens(body) <= MAXIMUM_PREAMBLE_TOKENS) {
        preamble = body;
        return;
      }
      const paragraphs = body.split(/\n{2,}/);
      const kept: string[] = [];
      let rest = paragraphs;
      for (let i = 0; i < paragraphs.length; i += 1) {
        const candidate = [...kept, paragraphs[i]].join("\n\n");
        if (kept.length > 0 && estimateTokens(candidate) > MAXIMUM_PREAMBLE_TOKENS) {
          rest = paragraphs.slice(i);
          break;
        }
        kept.push(paragraphs[i]);
        rest = paragraphs.slice(i + 1);
      }
      preamble = kept.join("\n\n").trim();
      const overflow = rest.join("\n\n").trim();
      if (overflow.length > 0) {
        chunks.push({
          text: overflow,
          headingPath: [...bufferHeadings],
          startLine: bufferStart,
        });
      }
      bufferStart = endExclusive;
      return;
    }
    chunks.push({
      text: body,
      headingPath: [...bufferHeadings],
      startLine: bufferStart,
    });
    bufferStart = endExclusive;
  }

  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      buffer.push(line);
      return;
    }
    flush(index + 1);
    const depth = heading[1].length;
    const title = heading[2].trim();
    stack.length = Math.max(0, depth - 1);
    stack[depth - 1] = title;
    bufferHeadings = stack.filter((entry) => entry !== undefined);
    bufferStart = index + 1;
    if (depth > 1) {
      seenHeading = true;
    }
  });
  flush(lines.length);

  return { preamble, chunks };
}

/**
 * Split YAML on top-level list items, keeping comments with their item.
 *
 * Deliberately not a YAML parse. `inventory.yaml` carries a correction that
 * exists only as a trailing comment block, and a parser drops comments — so
 * parsing would keep the superseded note and lose the thing that corrects it.
 * Raw text keeps both.
 */
function splitYaml(text: string): RawChunk[] {
  const lines = text.split("\n");
  const chunks: RawChunk[] = [];
  let buffer: string[] = [];
  let start = 1;

  function flush(): void {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (body.length > 0) {
      chunks.push({ text: body, headingPath: [], startLine: start });
    }
  }

  lines.forEach((line, index) => {
    // A new list item at any indentation starts a new entry. Comments and
    // continuation lines attach to whatever item they follow.
    if (/^\s*-\s/.test(line) && buffer.length > 0) {
      flush();
      start = index + 1;
    }
    buffer.push(line);
  });
  flush();

  return chunks;
}

/** Pull the frontmatter block off a message, leaving the body. */
function splitFrontmatter(text: string): { context: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    return { context: "", body: text };
  }
  return { context: match[1].trim(), body: text.slice(match[0].length) };
}

/** Split a paragraph run into pieces that fit the given token budget. */
function packParagraphs(
  text: string,
  startLine: number,
  budget: number,
): RawChunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: RawChunk[] = [];
  let buffer: string[] = [];

  for (const paragraph of paragraphs) {
    const candidate = [...buffer, paragraph].join("\n\n");
    if (buffer.length > 0 && estimateTokens(candidate) > budget) {
      chunks.push({
        text: buffer.join("\n\n"),
        headingPath: [],
        startLine,
      });
      buffer = [paragraph];
    } else {
      buffer.push(paragraph);
    }
  }
  if (buffer.length > 0) {
    chunks.push({ text: buffer.join("\n\n"), headingPath: [], startLine });
  }
  return chunks;
}

/**
 * Break a chunk that is still too long, preferring natural boundaries.
 *
 * Splits at a paragraph break, then a sentence end, then by force with
 * overlap so a fact spanning the cut is retrievable from either side. Never
 * truncates: the model would do that silently, which is the failure this
 * avoids.
 */
function enforceTokenTarget(
  chunk: RawChunk,
  prefixTokens: number,
): RawChunk[] {
  const headingTokens = estimateTokens(chunk.headingPath.join(" > "));
  const available = Math.max(
    MINIMUM_BODY_TOKENS,
    CHUNK_TARGET_TOKENS - prefixTokens - headingTokens,
  );

  if (estimateTokens(chunk.text) <= available) {
    return [chunk];
  }

  const byParagraph = packParagraphs(chunk.text, chunk.startLine, available);
  if (byParagraph.length > 1) {
    return byParagraph.flatMap((piece) =>
      enforceTokenTarget({ ...chunk, text: piece.text }, prefixTokens),
    );
  }

  const limit = available * CHARACTERS_PER_TOKEN_ESTIMATE;
  const pieces: RawChunk[] = [];
  let cursor = 0;
  while (cursor < chunk.text.length) {
    const end = Math.min(cursor + limit, chunk.text.length);
    const window = chunk.text.slice(cursor, end);
    const sentenceEnd = window.lastIndexOf(". ");
    const cut =
      end < chunk.text.length && sentenceEnd > limit / 2
        ? cursor + sentenceEnd + 1
        : end;
    pieces.push({ ...chunk, text: chunk.text.slice(cursor, cut).trim() });
    if (cut >= chunk.text.length) {
      break;
    }
    cursor = Math.max(cut - HARD_SPLIT_OVERLAP_CHARACTERS, cursor + 1);
  }
  return pieces;
}

/**
 * Split one file into chunks.
 *
 * @param file - The file, with its text.
 * @returns Its chunks, in document order.
 */
export function chunkFile(file: StoreFile): MemoryChunk[] {
  const isMessage = isMessagePath(file.path);
  const deep = isDeep(file.path);
  const lineCount = file.text.split("\n").length;

  let preamble = "";
  let raw: RawChunk[];

  if (file.path.endsWith(".yaml")) {
    raw = splitYaml(file.text);
  } else if (isMessage) {
    const { context, body } = splitFrontmatter(file.text);
    preamble = context;
    // Packed against the full target here and re-split below once the
    // frontmatter's own cost is known, so the budget is charged once rather
    // than guessed at twice.
    raw = packParagraphs(body.trim(), 1, CHUNK_TARGET_TOKENS);
  } else if (
    lineCount <= WHOLE_FILE_LINE_LIMIT
    && !/^#{2,6}\s/m.test(file.text)
  ) {
    // Short and undivided, so one argument. The second condition matters as
    // much as the first: a short file that its author split into sections has
    // been declared to be several things, and honouring that costs nothing.
    const firstHeading = /^#\s+(.*)$/m.exec(file.text);
    raw = [
      {
        text: file.text.trim(),
        headingPath: firstHeading ? [firstHeading[1].trim()] : [],
        startLine: 1,
      },
    ];
  } else {
    const split = splitMarkdown(file.text);
    preamble = split.preamble;
    raw = split.chunks;
  }

  // The token budget applies to what is embedded, which is the chunk plus its
  // heading path and preamble — not the chunk alone. Measuring only the body
  // let a 310-token chunk under a 300-token preamble reach 610 and be silently
  // truncated by the model. The prefix cost is charged before splitting.
  const prefixTokens = estimateTokens(preamble) + PREAMBLE_JOIN_TOKENS;

  return raw
    .flatMap((chunk) => enforceTokenTarget(chunk, prefixTokens))
    .filter((chunk) => chunk.text.trim().length > 0)
    .map((chunk, index) => {
      const applied = applySupersession(chunk.text);
      const lines = chunk.text.split("\n").length;
      const body = applied.text.trim();
      return {
        path: file.path,
        ordinal: index,
        headingPath: chunk.headingPath,
        filePreamble: preamble,
        text: body,
        superseded: applied.superseded,
        containsSuperseded: applied.containsSuperseded,
        // The first chunk of a file has nothing before it to depend on, so a
        // pronoun there refers to the title or to nothing — either way there
        // is no sibling to fetch.
        dependsOnPrevious:
          index > 0 && DANGLING_REFERENCE_PATTERN.test(body),
        isMessage,
        isDeep: deep,
        startLine: chunk.startLine,
        endLine: chunk.startLine + lines - 1,
      };
    });
}

/**
 * The text actually searched and embedded for a chunk.
 *
 * Heading ancestry and the file preamble are prepended rather than stored
 * separately, so that a query matching "second-hand" or "ChatGPT summary"
 * reaches the facts qualified by those words, and so an embedding of the
 * chunk carries its own context.
 *
 * @param chunk - The chunk.
 * @returns Text for scoring and embedding.
 */
export function chunkSearchText(chunk: MemoryChunk): string {
  const parts = [
    chunk.headingPath.join(" > "),
    chunk.filePreamble,
    chunk.text,
  ];
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

/**
 * Split every file in the store.
 *
 * @param files - Every file, with its text.
 * @returns Every chunk, in file order.
 */
export function chunkStore(files: StoreFile[]): MemoryChunk[] {
  return files.flatMap((file) => chunkFile(file));
}
