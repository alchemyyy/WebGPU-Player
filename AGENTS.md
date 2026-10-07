# Agent Guide

The documentation is the mdBook in `docs/`. Start with
[docs/src/SUMMARY.md](docs/src/SUMMARY.md) and the
[Introduction](docs/src/introduction.md): they map the engine and its Jellyfin
host, covering architecture, negotiation, codec support, modules, the build,
and settled decisions.

- Run `npm run typecheck`, `npm test`, and `npm run lint` before committing.
  When the engine is checked out inside its host, the host checks in
  [The Jellyfin host](docs/src/jellyfin-host.md#build-and-check) apply too.
- Update the book in the same change when a route, a module boundary, a build
  step, or a decision changes; see
  [Maintaining this book](docs/src/maintaining.md).
