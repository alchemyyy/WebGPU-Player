# Maintaining this book

The book is the engine's only documentation.
It is built with [mdBook](https://github.com/rust-lang/mdBook) 0.5.

## Build and read it

1. Install mdBook once: `cargo install mdbook --version 0.5.4 --locked`.
2. From the engine root, run `mdbook serve docs --open` while editing; it rebuilds on every save.
3. Before committing, run `mdbook build docs`; it fails on a broken `SUMMARY.md`.
   It writes the book to `docs/book/`, which is not tracked.

A push to `master` that changes `docs/` publishes the book to <https://alchemyyy.github.io/WebGPU-Player/>, through `.github/workflows/docs.yml`; its `MDBOOK_VERSION` is the version in step 1.

`docs/book.toml` holds the configuration, `docs/theme/` the stylesheets, and `docs/src/SUMMARY.md` the table of contents.
The Jellyfin plugin's book imports these stylesheets from their source paths, so keep their file names stable.
`docs/theme/favicon.svg` is a plain-SVG export of the logo; after changing `images/webgpu-player-logo.svg`, export it again from the engine root:

```sh
inkscape images/webgpu-player-logo.svg --export-plain-svg --export-filename=docs/theme/favicon.svg
```
A chapter that is not listed in `SUMMARY.md` is not built.

## Diagrams

Diagrams are PlantUML sources in `docs/diagrams/`, rendered to SVG in `docs/src/diagrams/`.
Both folders are tracked, so a book builds without Java.
Every diagram renders twice: a light variant for the rust theme and a dark variant for coal, and `docs/theme/diagrams.css` shows the one that matches the reader's theme.
`docs/theme/diagrams.js` turns each embedded diagram into an in-page viewer: drag pans, Ctrl+wheel, a pinch, or a double-click zooms, and a toolbar zooms, fits, or opens the SVG; a plain wheel still scrolls the page.
Without JavaScript the diagram scales to the column and links to its SVG.

You need Java 11 or later on PATH.
The first render downloads the pinned PlantUML jar into `bin/plantuml/` and checks its SHA-256.

1. Edit or add a source in `docs/diagrams/`.
   Start it with `@startuml` and `!include diagram-theme.puml`, and color activity nodes with the theme's semantic colors (`$HL_BLUE`, `$HL_GREEN`, `$HL_AMBER`, `$HL_NAVY`, `$HL_RED`).
   Never end a line inside a multi-line activity label with `;`, which ends the label.
2. Run `node tools/render-diagrams.mjs` from the engine root.
   With `--watch` it renders again on every save, beside `mdbook serve`.
3. Embed both variants where the diagram belongs:

   ```html
   <div class="diagram">
   <a class="diagram-light" href="diagrams/<name>.light.svg"><img src="diagrams/<name>.light.svg" alt="<what it shows>"></a>
   <a class="diagram-dark" href="diagrams/<name>.dark.svg"><img src="diagrams/<name>.dark.svg" alt="<what it shows>"></a>
   </div>
   ```

4. Before committing, run `node tools/render-diagrams.mjs --check`, which fails when a committed SVG is stale, missing, or has no source.

The Jellyfin plugin's book includes `diagram-theme.puml` from here, so keep its name and variables stable.

## When to update it

Update the chapter in the same change that alters what it describes:

- a route, a probe, a route key, or an eligibility rule: [Eligibility and routes](routes.md) and [HEVC and Dolby Vision support](codec-support.md);
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
- Follow the path conventions in the [Introduction](introduction.md): engine paths from the engine root.
- Keep Jellyfin integration out: the player, the device profile, PlaybackInfo, settings, and the add-on belong in the Jellyfin plugin's book.
  Jellyfin's media metadata, which the engine reads as its input, belongs here.
- Never include credentials, server addresses, item IDs, media titles or paths, or absolute machine paths.
