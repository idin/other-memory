# Server identity

How an MCP server names itself, and which field a client actually shows.

## `serverInfo`

The server returns `serverInfo` in its response to `initialize`. It carries
three fields, and the distinction between the first two is the one most easily
got wrong.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { },
    "serverInfo": {
      "name": "ExampleServer",
      "title": "Example Server Display Name",
      "version": "1.0.0"
    },
    "instructions": "Optional instructions for the client"
  }
}
```

`serverInfo` is an `Implementation`, which extends `BaseMetadata` with a
`version`. `BaseMetadata` is where `name` and `title` are defined, and the
SDK's own comments state their purposes plainly:

- **`name`** — "Intended for programmatic or logical use, but used as a display
  name in past specs or fallback." Required.
- **`title`** — "Intended for UI and end-user contexts — optimized to be
  human-readable and easily understood, even by those unfamiliar with
  domain-specific terminology." Optional.
- **`version`** — the server's own version, not the protocol's.

### Which one is displayed

`title` when present; `name` as the fallback. The fallback is why a server
that sets only `name` still shows something sensible, and why a display name
placed in `name` appears to work.

It is still wrong to put a display name in `name`, because `name` is an
identifier elsewhere. Claude Code namespaces tools as
`mcp__<server-name>__<tool-name>`, so a `name` containing spaces or
punctuation ends up inside a generated identifier.

The safe shape:

```ts
new McpServer({
  name: "other-memory",     // slug: matches the package and repository
  title: "Other Memory",    // what a person reads
  version: "0.2.0",
});
```

### What clients actually do

Client behaviour does not always match the spec, and this is worth checking
per client rather than assuming:

- **Claude Code** uses `name` for the tool prefix, as above.
- **claude.ai custom connectors** ask the person adding the connector to type
  a name, and display that. Neither `name` nor `title` from the server
  overrides what was typed. Observed 2026-08-10; the support article does not
  document the name field.
- **Claude Desktop's Cowork surface** has been reported to ignore
  `serverInfo.name` entirely and generate a UUID slug instead.

The lesson: the spec tells you what to send. It does not tell you what a
given client will show. Confirm in the client before changing anything on the
strength of what it ought to do.

## `instructions`

Optional free text returned alongside `serverInfo`, describing how to use the
server. Clients may pass it to the model as context.

## Icons

`Implementation` carries an optional `icons` array, introduced by SEP-973 and
first specified in revision `2025-11-25`. The same field is accepted on tools,
prompts, resources and resource templates, so a server can give each of them
its own icon rather than only branding itself.

### Schema

```ts
type Icon = {
  src: string;                  // required
  mimeType?: string;            // e.g. "image/png", "image/svg+xml"
  sizes?: string[];             // "48x48", or "any" for scalable formats
  theme?: "light" | "dark";
};
```

- **`src`** is a URI: `http(s):` or a `data:` URI with base64 image data. A
  `data:` URI is self-contained, which matters for a server whose domain a
  client may not want to fetch from.
- **`sizes`** omitted means the icon may be used at any size.
- **`theme`** omitted means the icon suits either background. Supplying two
  entries, one per theme, is how a server offers both.

Declared through the `McpServer` constructor alongside the other identity
fields:

```ts
new McpServer({
  name: "other-memory",
  title: "Other Memory",
  version: "2.5.0",
  icons: [{ src: "data:image/svg+xml;base64,...", mimeType: "image/svg+xml",
            sizes: ["any"] }],
});
```

The installed `@modelcontextprotocol/sdk` carries `icons` on its
`BaseMetadata`-derived schemas, so this typechecks without any version bump.

### Security guidance from the spec

Two warnings, both aimed at the consuming client rather than the server:

> Consumers SHOULD take steps to ensure URLs serving icons are from the same
> domain as the client/server or a trusted domain.

> Consumers SHOULD take appropriate precautions when consuming SVGs as they
> can contain executable JavaScript.

The second is the reason a client may decline to render an SVG at all, and a
reason to prefer PNG for an icon that must be shown.

### What claude.ai actually does with it

Nothing, for custom connectors. Every custom connector renders a generic icon
regardless of what the server advertises; branded icons are configured by
Anthropic for first-party listings. Sending `icons` is harmless and
spec-correct, but it changes nothing a person sees.

Re-checked 2026-08-27, and the request is still open upstream. So for a custom
connector the **name carries all the identification** — which is why the name
is worth getting right and the icon is not worth waiting for.

## Sources

- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- `@modelcontextprotocol/sdk` — `dist/esm/types.js`, `BaseMetadataSchema`
  (line 298) and `ImplementationSchema` (line 315)
- https://github.com/anthropics/claude-ai-mcp/issues/167 — Cowork falling back
  to a UUID instead of the advertised name
- https://github.com/anthropics/claude-ai-mcp/issues/152 — icons not rendered
  for custom connectors
- https://modelcontextprotocol.io/specification/draft/schema — the `Icon` type,
  its fields, and the SVG and trusted-domain warnings
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2573
  — displaying branded icons for a custom MCP server
- https://github.com/anthropics/claude-code/issues/44675 — custom connectors
  not rendering description or icons from server metadata
- https://github.com/anthropics/claude-code/issues/49040 — custom icons for
  MCP servers and marketplace plugins
