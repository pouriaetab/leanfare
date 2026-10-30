# Contributing

Issues and pull requests are welcome.

- **Found a bug?** Open a [bug report](https://github.com/pouriaetab/leanfare/issues/new?template=bug_report.yml). Questions and ideas go to [Discussions](https://github.com/pouriaetab/leanfare/discussions).
- **Run it from the source:** install [Bun](https://bun.sh) 1.4, then `bun install` and `bun src/cli.ts`; it opens on http://127.0.0.1:4747.
- For a bigger change, open an issue first, so we agree on the shape before the code.
- One change per pull request, with a test that fails without it. `bun test` runs everything against fake providers, so no key and no network are needed.
- Run `bun scripts/preflight.ts` before you open the pull request (types, tests, licences and the live smoke test).
- Keep it light: no runtime dependencies. Anything taken from elsewhere (code, data, models) must be under a licence that allows business use without paying; `bun scripts/licences.ts` checks the ones Leanfare uses.
- The screens are plain JavaScript in `ui/`, with no build step.
