# Dependencies

Every package this project depends on, with its license.

## Rules

- Only free packages under a permissive license: MIT, Apache 2.0, BSD or ISC.
- No GPL or AGPL packages.
- Nothing that needs a purchase or a signed agreement.
- Add a row here in the same change that adds a dependency.

## Direct dependencies

This table is written by `npm run deps:render` from `package.json` and the installed packages. Do not edit it by hand.

<!-- deps:start -->
| Package | Installed version | License | Used for | Runtime or development |
|---|---|---|---|---|
| `@cloudflare/containers` | 0.3.7 | MIT OR Apache-2.0 | Starts the container of a Claude Code job in the workspace and intercepts its calls to the API | Runtime |
| `acorn` | 8.19.0 | MIT | Parses JavaScript for the code-reading checks of the hosted code migration | Runtime |
| `yaml` | 2.9.1 | ISC | Reads and writes the charter file | Runtime |
| `zod` | 4.6.7 | MIT | Schemas for the charter, ledger entries and hook input | Runtime |
| `@biomejs/biome` | 2.6.8 | MIT OR Apache-2.0 | Lint | Development |
| `@types/node` | 22.20.5 | MIT | Type declarations for Node | Development |
| `typescript` | 7.0.2 | Apache-2.0 | Type checking and the build | Development |
| `vitest` | 3.2.7 | MIT | Unit and integration tests | Development |

`npm run deps:check` checks every installed package, direct or indirect, against these rules. It is part of `npm run check`.
<!-- deps:end -->
