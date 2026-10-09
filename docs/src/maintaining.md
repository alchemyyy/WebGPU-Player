# Maintaining this book

The book is the engine's only documentation.
It is built with [mdBook](https://github.com/rust-lang/mdBook) 0.5.

## Build and read it

1. Install mdBook once: `cargo install mdbook --version 0.5.4 --locked`.
2. From the engine root, run `mdbook serve docs --open` while editing; it rebuilds on every save.
3. Before committing, run `mdbook build docs`.
   It fails on a broken `SUMMARY.md`, and it rewrites `docs/book/`, which is tracked.
   Commit the rebuilt book with the chapters it was built from.

`docs/book.toml` holds the configuration, and `docs/src/SUMMARY.md` the table of contents.
A chapter that is not listed in `SUMMARY.md` is not built.

## When to update it

Update the chapter in the same change that alters what it describes:

- a route, a probe, a route key, or an eligibility rule: [Negotiation and routes](negotiation.md) and [HEVC and Dolby Vision support](codec-support.md);
- a file added, moved, or removed: [Module map](module-map.md), and [Repository layout](layout.md) for a folder;
- a decoder or a build step: [WebAssembly decoders](decoders.md);
- a vector or a generator: [Codec vectors](codec-vectors.md);
- a settled investigation: [Decisions](decisions.md).
  Never delete an entry; revise it when its facts change, rather than adding one that contradicts it.

## How to write it

- Record durable facts: architecture, routes, layout, procedures, and decisions.
  Git already records history and working-tree state, so there are no changelogs, status snapshots, or "uncommitted" notes.
- Write procedures as recipes: what you need, numbered steps, then how to check the result.
- Prefer plain sentences and short lists.
  Use a table only for data that has columns.
  Keep bold, callouts, and decoration out.
- Put each sentence on its own line; never wrap a line at a fixed column.
- Use ASCII only.
- Follow the path conventions in the [Introduction](introduction.md): engine paths from the engine root, host paths from the plugin root marked (host).
- Never include credentials, server addresses, item IDs, media titles or paths, or absolute machine paths.
