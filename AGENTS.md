# Agent Guide

Start with [.agents/README.md](.agents/README.md). It maps the engine and its
Jellyfin Web host: architecture, negotiation, codec support, modules,
integration, and settled decisions.

- Run `npm run typecheck`, `npm test`, and `npm run lint` before committing.
  When the engine is checked out inside the host, the host checks in
  [.agents/INTEGRATION.md](.agents/INTEGRATION.md) apply too.
- Update `.agents/` when a route, module boundary, or decision changes.
