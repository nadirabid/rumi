# AGENTS.md

## This checkout is the Rumi fork

Rumi is a **separate installable macOS app** built on DeepSeek Harness. This repo is a fork of `deepseek-ai/deepseek-harness` (tag `dsh-v0.2.1-rc.3`). Upstream is the `upstream` remote. `apps/rumi` is the only product surface we own, and the stock app in `apps/desktop` must keep building unchanged from the same tree.

### Why it exists

Rumi is for my kids: play, creation, and learning alongside an agent. Prefer simple, safe defaults without requiring knowledge of modes, permissions, plugins, or terminals. Expect exploratory clicks: confirm destructive actions and keep recoverable actions discoverable. Fun must preserve safety and clarity. Admit a general-purpose improvement only if it helps a child use the app; when uncertain, choose the smaller change.

**Hard product requirement:** Rumi is a robot tool restricted to the current project type. Never add emotional probing, personal counseling, companionship, or relationship-building behavior. Apply the [conversation scope](RUMI.md#conversation-scope) to both the backend agent and live voice, including existing projects and custom voice instructions.

The table is the complete allowed-change set; everything else is shared upstream code.

### Allowed to modify

| Path | Why |
|---|---|
| `apps/rumi/**` | the app: identity, profile bootstrap, icons, welcome window |
| `apps/rumi/brand/**` | **new** plugin packages we add — brand now, the custom UI bundles later |
| root `package.json` (only the `*:rumi` scripts) | build entry points |
| `scripts/client-build-environment.ts` (only `DSH_CLIENT_TITLE`) | window title |
| `packages/client/web/src/boot-page.ts` (only the wordmark text) | boot splash — no slot for it |
| `packages/client/ui-settings-account/` | locale copy, plus the Plugins and Automation task rows in the account menu — the single bottom More control Rumi keeps |
| `packages/client/{ui-settings-models,ui-sidebar-documentpreview,ui-plugin-manager}/` locale copy | product name in visible text; no locale-override seam exists |
| `packages/client/ui-sidebar/` (launcher pinning only) | Rumi hides the Plugins and Automation rows by seeding `__DSH_HIDDEN_PANELS__`; a build that seeds nothing renders exactly as stock |
| `RUMI.md`, `AGENTS.md` | documentation |

### Forbidden

- `apps/desktop/**` — the stock app must build unmodified.
- `apps/cli/**`, `apps/web/**`, `apps/desktop-host/**` — shared runtime.
- `packages/**` except the boot-page wordmark line above — published upstream packages.
- Renaming or deleting upstream files, or gating upstream behaviour behind a fork flag.

If a change seems to need one of these, build it as a package under `apps/rumi/brand/`-style directories and compose it into Rumi's profile. The slot system exists for this: `ctx.slots` replaces UI, a bundle patch replaces loader rows, and neither needs a fork.

### Product facts

[RUMI.md](RUMI.md#what-differs-from-upstream) owns app identity and home isolation; [Terms](RUMI.md#terms) owns product terminology. Append facts there rather than restating them.

### Plugin UI

Before changing `apps/rumi/brand/**`, read and follow [Rumi's plugin UI requirements](RUMI.md#plugin-ui-requirements).

### Build and verification

Before building, packaging, installing, or verifying Rumi, read and follow [Build](RUMI.md#build), [Package](RUMI.md#package), [Install and run](RUMI.md#install-and-run), [build constraints](RUMI.md#build-constraints), and the [completion checks](RUMI.md#verify-before-claiming-done). These requirements apply to every Rumi change.

---

Everything below is upstream's contributor guide and still applies to upstream code.

DeepSeek Harness is an all-plugin Cordis agent harness. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Pre-stable APIs and released Session data

Public APIs are pre-stable; update every consumer. Follow [version/status](docs/session-format-status.md) and [type acknowledgements](docs/cookbook/reviewing-persistence-type-changes.md). [Adjacent migration](.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) may add a version-named successor but never move, overwrite, or delete committed generations; predecessors imply neither fallback nor downgrade support. SQLite uses monotonic `SCHEMA_VERSION`.

Acknowledge [declared persistence-type changes](docs/cookbook/reviewing-persistence-type-changes.md).

Record each externally perceptible breaking change immediately in an [upgrade guide](.agents/skills/dsh-create-upgrade-guide/SKILL.md).

**Application launch.** Only `dsh` profiles launch supported Node apps; package bins, demos, and public SDK argv escapes are forbidden ([rule](docs/architecture.md#application-launch)).

## Repository layout

Use the [repository map](RUMI.md#repository-layout-reference) and [package-group guide](packages/README.md) to locate owners. Nonexperimental packages need product use or an explicit [classification](scripts/product-package-policy.ts); [experimental status](packages/experimental/README.md#status) is independent of optional delivery.

## Commands

Read the [shared command reference](RUMI.md#shared-development-commands) before running repository commands; the checks below still apply.

### Host sandbox failures

If a required `gh`, `pnpm`, build, test, or generator command fails because the sandbox blocks credentials, network, IPC, watching, or nested `sandbox-exec`, retry unchanged with the narrowest host escalation. Require sandbox evidence; never bypass test failures or the product sandbox.

### Run relevant checks locally

Before pushing, follow [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md); report only commands run. After `gh stack sync`, validate immediately; do not merge before checks pass.

- Match evidence to the surface: focused behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths, and real-API e2e for providers.
- Never default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage and the platform matrix; rehearse all locally only by explicit request, for CI diagnosis, or for an irreducibly repository-wide change.
- `test:coverage`, not `test`, is the CI coverage gate ([why](docs/testing.md)).
- Develop with `build:artifacts`; before claiming completion, run `build:check` after the latest `build:artifacts`, or `build` ([layout](docs/development.md#typescript-project-layout)).
- **Web browser automation and GIF recording:** launch with `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` to use the [in-page directory picker](apps/web/tests/pin-browse-picker.overlay.yml); omit this override only when testing native picker behavior explicitly.

## Secrets / .env

Windows packaging/signing: [required reading](apps/desktop/windows-signing/README.md).

Real-API tests/demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. cordis.yml allows `!!js` (never `!js`) under plugin `config` and entry `disabled`; other metadata stays literal, so conditional composition also uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials. CI e2e skips without a key; [testing.md](docs/testing.md) owns key policy.

## Conventions

- Packages use `@deepseek-ai/dsh-<name>`; vendor is [rescoped](docs/rescope.md) and `private: true`. Harness packages declare `@deepseek-ai/cordis` in `peerDependencies`/`devDependencies`. Workspace dependency sections use DSH `workspace:*`, vendor/native `workspace:~` ([rules](.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. Config subprocesses run built `lib/` under plain Node; source regressions use their declared launcher ([testing policy](docs/testing.md#test-subprocess-launch-modes)). The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM (no CJS-only exports) — Node's native TypeScript modes are unavailable across the engines range ([source-launch contract](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md)). Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`. Public service methods document parameters and non-void returns. `SessionEventMap` members are required-on-read unless the envelope carries `ignorable: true`. Bump `SESSION_FORMAT_VERSION` only when existing discriminators cannot prevent unsafe interpretation; same-version changes require safe reader behavior ([review](.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md)).
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **A capability seam comprises Service Definition / Service Provider / Consumer roles.** It is complete, never one role; split only when roles evolve independently ([glossary](docs/glossary.md#capability-seam)).
- **Prefer maintained dependencies over hand-rolling** when they genuinely delete owned code and tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- **Explicit > implicit at package boundaries**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-shell` request/spec split is the template).
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust TypeScript at typed same-process boundaries.** Do not add runtime validation, fallback behavior, or hostile-input tests solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries.
- **No new assertions to `unknown`** (`as unknown` or `<unknown>`). Preserve or reduce the exact legacy baseline; use typed values or validation for replacements ([rule](.agents/notes/implemented/process/2026-09-19-no-unknown-casts.md)).
- **Source plane vs artifact plane, never mixed.** Static gates and tests resolve workspace imports through tsconfig `paths` to `src` and pass on a clean tree; gates consuming built `lib/` declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Keep compiler faces explicit.** A package with both Host and Client programs exposes face-specific leaf configs and a solution-only root; repo-wide programs seed a face config, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- **Error handling:** use typed, structured failures and localized, actionable reports. Define handling ownership, containment, and failure guarantees; stop dependent work and visibly report untrusted state or unknown outcomes. Follow [dsh-error-handling](.agents/skills/dsh-error-handling/SKILL.md).
- **An empty `catch` names the error** and why; keep its `try` to one statement.
- **Keep comments local.** Do not restate code, expand unrelated comments, or explain distant behavior without local need ([rationale](.agents/skills/dsh-prose-standard/SKILL.md)).
- **Ban `prove` + `nance`** ([rule](.agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md)).
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Create Agent Notes only for durable decision rationale;** mechanical/local edits are exempt, including local UI changes ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- **Official plugin artwork:** use [dsh-official-plugin-artwork](.agents/skills/dsh-official-plugin-artwork/SKILL.md) for official and official experimental plugin icons; obtain designer approval before landing new glyphs.
- **Client UI copy is locale-owned.** Route product text through typed dictionaries and `t` or localized primitive props; `verify-client-ui-i18n` rejects hardcoded copy ([decision](.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).
- **Testing policy** — [docs/testing.md](docs/testing.md). Every non-trivial model- or product-user-visible change updates a keyless recorded-session snapshot; [snapshot ownership](snapshots/AGENTS.md) reserves the top-level tree for session-driven cases and keeps other expected output owner-local. Fixtures replay on macOS/Linux; fix fixtures, not normalizers.
- **Design each tool's UI presentation up front.** Host presenters stay pure; Web cards derive from raw events and persisted result metadata ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for capability seams, lifecycle paths, and transcript output; include missing snapshot-harness support in the same change.
- **Both SDKs project the loop.** Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR; `pnpm run test` covers neither ([surfaces](docs/testing.md#when-a-snapshot-test-is-required)).
- **Choose PR history deliberately.** Split independent changes and fix the introducing PR before propagation. Standalone/stack branches may merge-forward or rebase. Rewrites use `--force-with-lease`, abort on remote movement, never raw `--force`; preserve an in-progress merge-forward checkpoint before taking a newer base ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- **Labels:** one PR `kind/*`, all material `area/*`, and native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.

## Defensive patterns

Read [docs/defensive-patterns/README.md](docs/defensive-patterns/README.md) before changing a package surface, remote service, client component or state, conversation or Session behavior, or lifecycle, concurrency, subprocess, and teardown code. Its [review principles](docs/defensive-patterns/README.md#why-these-rules) apply per artifact.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` explains why narrowing is infeasible. Every module and export has concise JSDoc for its non-obvious contract; function-like exports include `@param`/`@returns`, as enforced by `verify-export-jsdoc`. Heritage-declared members, plugin-protocol slots, and constructors keep their docs at the declaring Service Definition, protocol, or class.

Before writing comments or documentation, follow the [prose requirements](RUMI.md#prose-requirements) and [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md).

Docs accompany every code change: update affected README and JSDoc contracts together. Routine bilingual work follows [docs/AGENTS.md](docs/AGENTS.md); only explicit user invocation may run `dsh-translate-docs`. Current-state prose, one physical line per paragraph, one home per fact, and word budgets live there.

## Editing these instructions

`CLAUDE.md` symlinks `AGENTS.md` at root and `packages/`; edit the real file. Keep each rule self-contained while linking high-level docs. Condense when clarity survives; raise a `verify-doc-budgets` ceiling when the required content genuinely needs more space.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.
