# Agent Guide

The documentation is the mdBook in `docs/`.
Start with [docs/src/SUMMARY.md](docs/src/SUMMARY.md) and the [Introduction](docs/src/introduction.md): they map the engine, covering architecture, eligibility and routes, codec support, modules, the build, and settled decisions.
The Jellyfin integration is documented in the plugin repository's own book, in its `docs/`.

- Run `npm run typecheck`, `npm test`, and `npm run lint` before committing.
  When the engine is checked out inside its host, the host's checks, in its book's "The client add-on" chapter, apply too.
- Update the book in the same change when a route, a module boundary, a build step, or a decision changes; see [Maintaining this book](docs/src/maintaining.md).
