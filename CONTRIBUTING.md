# Contributing

Issues and pull requests are welcome.

- One change per pull request, with a test that fails without it. `bun test` runs everything against fake providers, so no key and no network are needed.
- Run `bun scripts/preflight.ts` before you open the pull request (types, tests, licences and the live smoke test).
- Keep it light: no runtime dependencies. Anything taken from elsewhere (code, data, models) must be under a licence that allows business use without paying; `bun scripts/licences.ts` checks the ones Leanfare uses.
- The screens are plain JavaScript in `ui/`, with no build step.
