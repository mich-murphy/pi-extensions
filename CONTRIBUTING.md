# Contributing

## Set up

The [Nix](https://nixos.org/) flake provides Node.js, the pinned Rust toolchain and a C compiler. Enter it, then install dependencies:

```sh
nix develop        # or: direnv allow
npm ci
```

Some end-to-end tests also need Python 3.

To try your working copy of one extension in Pi:

```sh
pi -e ./packages/pi-vim/index.ts
```

## Check your change

Run the full gate before opening a pull request. CI runs the same command:

```sh
npm run check
```

It runs these steps in order and stops at the first failure:

| Step | Command | Fails on |
| --- | --- | --- |
| Format | `npm run format:check` | Unformatted indexed TypeScript, JSON or config |
| Lint | `npm run lint` | Any finding, including warnings |
| Types | `npm run typecheck` | Any TypeScript error |
| Rust | `npm run check:rust` | Gateway fmt, clippy, test or rustdoc failure |
| Tests | `npm run test:coverage` | A failing test, or coverage below 80% |
| Fallow | `npm run fallow` | Dead code, duplication or a function over the complexity limit, anywhere in the repo |
| Markdown | `npm run markdownlint` | Any Markdown lint finding |

### Git hooks

[prek](https://prek.j178.dev/) runs the same commands as Git hooks. Install them once with `prek install`, which adds both the pre-commit and pre-push hooks.

| Stage | Runs | Typical time |
| --- | --- | --- |
| `pre-commit` | File hygiene, format, lint, Markdown lint, types, Fallow dead code and duplication, gateway `cargo fmt`, and the tooling fixtures when their files change | A few seconds |
| `pre-push` | Gateway build, the coverage suite, then Fallow health against that coverage | About two minutes |
| `manual` | `npm run check:rust`, both Hegel property suites with a random seed, and every Bombadil suite in turn | Fifteen minutes or more |

Run the manual stage before a change that touches terminal behaviour, the gateway or a property:

```sh
prek run --stage manual --all-files
```

### Repository file scope

Formatting, JavaScript/TypeScript lint and Markdown lint use `scripts/repository-quality.ts` to select existing regular files from the **Git index** (`git ls-files --cached -z`). This includes every tracked file of the relevant type, including dotfiles, agent skills/config and newly staged additions. They check the current working-copy content, not the staged blob. Unstaged edits are checked; files deleted from disk or staged for deletion are not. Indexed symlinks of these types fail with an actionable error rather than following a target outside the checkout.

**Stage new source/config/documentation files before checking them:**

```sh
git add -- path/to/new-file.ts
npm run format:check
npm run lint
npm run markdownlint
```

Untracked files are not part of these three checks, even if they are production additions. Review `git status --short` before opening a pull request so intended additions are staged. Untracked `.agents/tasks` evidence, `.direnv` caches, dependency directories and generated output therefore cannot contaminate these checks. There is no directory-wide exclusion for tracked agent files or production sources. A fresh clone and a linked Git worktree use the same index policy. These commands require Git and installed local tools (`npm ci`); query or tool failures stop the gate, not fall back to whole-tree discovery. An empty relevant file list succeeds without invoking a tool.

`npm run format` writes the same indexed formatter files; `npm run format:check` checks without writing. Pre-commit uses the same formatter, linter and Markdown commands as `npm run check`. The formatter selects its supported source/config extensions (Markdown remains governed by Markdown lint); the linter selects JavaScript/TypeScript and Vue, and Markdown lint selects `.md`. Git NUL-delimited paths and shell-free tool arguments preserve spaces, newlines and literal glob characters. When adding a new language supported by a pinned tool, update the selector and its fixture tests together.

`npm test` and `npm run test:coverage` first run the offline tooling fixtures (`npm run test:tooling`), then the existing Vitest suite. The tooling fixtures create temporary Git repositories and exercise real local tools; they do not call providers or change your checkout's index. Type checking, Rust, Vitest coverage and Fallow retain their own scope and thresholds; this index policy does not change them. Do not hide gate failures behind `tail` or `tee`: run commands directly, or use `set -o pipefail` when a pipeline is necessary and preserve its failure status.

The native adapter test needs the built gateway, which `npm run check:rust` builds. In a fresh clone, run it or `cd packages/pi-peers/gateway && cargo build --locked` before `npx vitest run`, or that test fails and names the missing binary.

Fix findings rather than silencing them:

- Suppress a lint rule only on the offending line, with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- Do not add `fallow-ignore` comments, raise thresholds or exclude files.

While working on a branch, `npm run fallow:audit` lists only the Fallow findings your branch introduces.

## Why these gates

The numbers are project conventions. They keep review tractable; no source gives them as the right values.

**Coverage.** The 80% threshold on branches, lines and statements is a floor, not a target, and not evidence that the tests are good. Coverage shows which code no test runs. It does not show that a test would fail when the code is wrong. Google publishes a [60% acceptable, 75% commendable, 90% exemplary](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html) guideline and avoids broad top-down mandates. [Inozemtseva and Holmes (ICSE 2014)](https://www.cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf) found a low to moderate correlation between coverage and suite effectiveness once suite size is controlled for, and advise against using coverage as a quality target. Current coverage is about 96.5% of lines and 93.3% of branches. Judge a test by whether it fails when behaviour is broken: check it by mutating the code under test, and use [property tests](#property-tests) where inputs are open-ended.

**Complexity.** Fallow flags a function above cyclomatic complexity 20, cognitive complexity 15 or a CRAP score of 30, and above 60 lines. These are Fallow's defaults, and `.fallowrc.json` does not override them. They are looser than McCabe's original limit of 10. [NIST SP 500-235](http://www.mccabe.com/pdf/mccabe-nist235r.pdf) allows limits up to 15 when the project has operational advantages such as experienced staff. SonarSource's [cognitive complexity paper](https://www.sonarsource.com/docs/CognitiveComplexity.pdf) defines the metric and gives no threshold. The limits here are not claimed to be evidence-based.

## Remove a test that adds no detection

A test that repeats other tests costs time to read and maintain and adds no protection. [Fallow mutation testing](https://docs.fallow.tools) changes the code in small ways (mutants) and records which tests fail on each change. A test *kills* a mutant when it fails on it. A *unique kill* is a mutant that this test kills and no other test does.

**The rule.** A test with no unique kill can be removed after a person reads it and finds no reason below to keep it. Mutation evidence finds the candidates; it never removes a test on its own.

Keep a test with no unique kill when:

- It is the regression test of a fixed defect or of a property counterexample.
- It is the readable example of a contract that a property test or a large test otherwise covers.
- It is a property test. The kill matrix replays one fixed seed; the nightly run draws inputs that seed never reaches.
- It is a boundary row that a property's generator does not draw, such as a width below the property's range.
- It checks behaviour that mutants cannot reach: a child process, a real terminal, the gateway binary, a type-level contract, or an error message that a user reads.
- Its kills are shared only with other candidates. Removing all of them together loses the detection, so remove at most one of them.
- Its evidence is incomplete: a covering mutant timed out, broke the whole file at import, or has `kill_matrix_complete: false`.
- Another package's tests are its only co-killers. Each package's tests must still detect a change to that package on their own.

Low complexity does not mark a test as removable. Read each candidate.

### Run a removal pass

Run every mutation operator: the default set misses changes such as `every` to `some`. `.fallowrc.json` names all of them. Run mutation in the Docker sandbox, which keeps mutated code that writes files, spawns processes or opens sockets away from your checkout:

```sh
# 1. Save the baseline kill matrix of one package.
npm run mutation -- packages/pi-retry --kill-matrix --format json --quiet > .fallow/reports/pi-retry.json
# 2. Read each test with kills and no unique kill in kill_matrix.tests, and remove the ones the rule allows.
# 3. Prove that no detection is lost. The run lists each mutant that the baseline detected and this run does not.
npm run mutation -- packages/pi-retry --kill-matrix --format json --quiet --compare /reports/pi-retry.json
# 4. Prove that no coverage is lost.
npm run test:coverage
```

The `--compare` run must list no lost mutant, and line and branch coverage must not fall. `--compare` accepts only a complete report. `config/fallow-mutation.jsonc` hides the live tests, which the default Vitest config never lists, so the report stays complete. Give every test a title that is unique in its file and does not change between processes, for example no temporary path: Fallow attributes kills by title.

A package with thousands of mutants takes up to an hour. To check named tests without a full matrix, pass `--kill-matrix-for <file>` or `--kill-matrix-for '<file>::<describe> > <test>'`.

The weekly [tests audit](.github/workflows/tests-audit.yml) runs `--kill-matrix-for` on the test files changed in the past week and lists the tests with no unique kill in its job summary. It never fails and removes nothing.

## Property tests

Property tests use `@hegeldev/hegel`. Every property takes its settings from `propertySettings()` in `test-support/hegel-settings.ts`. The pull request gate replays seed 12345 with each property's own case count, so it is deterministic. A nightly workflow runs only the property tests with a random seed and 2,000 cases, to find inputs the fixed seed never reaches. It runs the TypeScript properties and the Rust gateway properties in `packages/pi-peers/gateway/tests` with the same seed and case count.

Both runs exist because a fixed seed makes the gate reproducible but explores the same inputs every time. Running other seeds locally during an evidence review found a genuine defect that seed 12345 never reached.

Two environment variables change every property, in both languages. The Rust ones read them in `packages/pi-peers/gateway/tests/support/mod.rs`, because the `hegeltest` crate ignores them for a property that pins its own seed. An invalid value fails the run:

| Variable | Effect |
| --- | --- |
| `HEGEL_SEED` | Replaces the seed. An integer from 0 to 2^64 - 1 |
| `HEGEL_TEST_CASES` | Replaces the case count |

Run the nightly set locally. It picks a random seed and prints it, with the case count, before the run:

```sh
npm run test:properties
npm run test:properties:rust
HEGEL_SEED=42 HEGEL_TEST_CASES=500 npm run test:properties
```

To reproduce a nightly failure, copy the seed and case count from the log and run the same command. The same seed and case count give the same inputs, so the shrunk counterexample is identical. Narrow it with a file path, for example `npm run test:properties -- packages/pi-vim`. A failing Rust property prints its seed and case count before the shrunk counterexample, so replay it with `npm run test:properties:rust` and those two values.

Turn every counterexample into a regression test with an explicit example before you fix the code. Hegel's failure database is off, so nothing else replays it. A failing property is either a defect in the code or a wrong property or generator. Fix the property when its oracle or generator allows a state that cannot occur.

Do not raise a timeout to fix a slow property. Make the property cheaper. A property that is inherently long wraps its timeout in `propertyTimeout()` so it grows with `HEGEL_TEST_CASES`.

### Terminal properties

Hegel tests code from inside the process. [Bombadil](https://antithesishq.github.io/bombadil/terminal/) tests the real Pi CLI from outside: it types random keys and resizes a real terminal emulator, then checks properties against what is on screen. It reaches the stdin parser, renderer and resize path that in-process tests replace with a fake terminal. It cannot see internal state.

Bombadil files live in `packages/<name>/test/bombadil/`. A specification is `*.bombadil.ts`; a test-only extension or launch fixture sits beside it. Bombadil reads every export as a property or action generator. `scripts/bombadil-pi.ts` starts the pinned Pi offline in a throwaway home with only the named extensions loaded.

```sh
npm run test:bombadil
npm run test:bombadil:peers:setup
npm run test:bombadil:peers:success
npm run test:bombadil:peers:messages
npm run test:bombadil:scrollback
npm run test:bombadil:skills
BOMBADIL_TIME_LIMIT=10m npm run test:bombadil
```

`test:bombadil` fuzzes the pi-vim editor: mode labels, Escape, width, resize while a command is pending, submit, and `x` on wide characters. Command effects are checked in-process by `vim-properties.test.ts`. `test:bombadil:peers:setup` fuzzes the `/peers` menu through `packages/pi-peers/test/bombadil/setup-extension.ts`, a test-only extension. Its backend waits 1.5 seconds, so the progress view can be checked, and then refuses every acquisition, so Apply never builds, downloads or starts a gateway. The properties check that Esc goes back exactly one level (and closes at the root), that the hint matches the depth, that the menu fits 80x20, that list screens highlight one row, that every progress view (Setup, Reconnect, Turn off) ends in an outcome with a known headline, and that the footer leaves `Peers: setting up…` once progress is hidden. Bombadil sees only the screen, so the extension also watches the agent and home directories during each `/peers` command and shows `probe:UNREVIEWED-WRITE <path>` in the footer if anything appears without a confirmed consent row, or `probe:UNREVIEWED-CHANGE <path>` if an existing file changes or disappears. Consent comes from the `observe.consented` test seam that the menu calls before any effect. After a consent, only the pi-peers config, directory and socket root may change, and only until that action's `peers-report` entry is written; every other path is still checked. `test:bombadil:peers:success` first builds the debug gateway, like `test:bombadil:peers:messages`, then gives setup a backend that copies it in. A guided generator steers to Apply, `/peers status` and `/peers reset`, and the properties check that setup ends on `✓ Peers set up`, the footer shows `Peers: connected`, status reports the connection, and `Turn off peers` really turns peers off (`✓ Peers turned off`, or status says peers is off). Bombadil passes obligations still open when the time limit ends, so the time-bounded checks sit well inside each suite's default limit. Its fixture stops the started gateway when Pi exits.

`test:bombadil:peers:messages` runs a real gateway. Its script first runs `cargo build --locked` in `packages/pi-peers/gateway`, which does nothing when the debug build is current, and stops if the build fails. The peers spec connects the driven Pi to a gateway that a scripted adapter peer also joins; an offline scripted model takes each delivered message, and a `peers-probe` footer line counts the takes. `test:bombadil:scrollback` loads a session with twelve marked prompts and checks that the context row names the nearest prompt above the viewport. `test:bombadil:skills` fills a throwaway home with skills and instruction files and fuzzes the `/skills` menu.

To see every byte Pi writes, set `PI_TUI_WRITE_LOG` to a file path. The launcher passes it through to Pi.

The run stops at the first violation and prints the trace directory. Replay it with `bombadil terminal test --reproduce <trace>` and the same command, or reduce it with `bombadil terminal shrink --trace <trace>`. Traces are large (150–300 MB per passing run) and are not deleted; they go to `bombadil_terminal_*` directories under `$TMPDIR`. Remove them with `rm -rf "$TMPDIR"/bombadil_terminal_*` when no run is active. Bombadil's terminal driver is experimental, so these runs are not part of `npm run check`. Run them when upgrading the pinned `@earendil-works/pi-coding-agent`, since they read Pi's on-screen text.

Check a new property by breaking the code it guards and confirming the run fails.

## Verify behaviour in real Pi

Some packages have an agent skill that drives a real, isolated Pi session. Run the matching skill after changing that package's behaviour:

| Skill | Use after changing |
| --- | --- |
| [verify-pi-claude](.agents/skills/verify-pi-claude/SKILL.md) | The Claude provider or the pinned Agent SDK. Needs a Claude subscription |
| [verify-pi-retry](.agents/skills/verify-pi-retry/SKILL.md) | Resume or retry behaviour |
| [verify-pi-skills](.agents/skills/verify-pi-skills/SKILL.md) | The toggle menu, saved state, prompt filtering or the read guard |
| [verify-pi-web](.agents/skills/verify-pi-web/SKILL.md) | Login, logout or web configuration |

## Dependencies

- Pin npm dependencies to exact versions.
- Put Pi's own packages (`@earendil-works/*`) in `peerDependencies` with a `*` range. Pi supplies them at runtime.
- Put other runtime packages in the owning package's `dependencies`.
- The Rust gateway uses Cargo version ranges with a committed `Cargo.lock`. Every Cargo command runs with `--locked`.

Renovate opens update pull requests on a schedule. Digest, pin and patch updates merge automatically. Two groups always wait for review:

- **Pi packages** (`@earendil-works/*`). A contract change type-checks against the pinned version and fails only in a live session.
- **The Claude Agent SDK.** Upgrading it needs a live check that CI cannot run. Follow the [SDK upgrade steps](packages/pi-claude/docs/sdk-upgrade.md).

## Naming

Each extension is named `pi-<word>`, where one word says what it does: `pi-vim`, `pi-retry`, `pi-peers`. Names users see follow the same word:

| What | Convention | Example |
| --- | --- | --- |
| Package directory and `name` | `pi-<word>` | `packages/pi-skills` |
| Slash command | At most one, `/<word>`, with actions as tab-completed arguments | `/claude [status\|usage]` |
| Session toggle | `/<word> [on\|off]`, built with `packages/shared/on-off-command.ts` | `/coffee off` |
| Model tools | `<word>_<action>` | `peers_send` |
| Environment variables | `PI_<WORD>_<SETTING>` | `PI_WEB_PROVIDERS` |
| Files in the agent directory | `pi-<word>.json` or `pi-<word>/` | `pi-skills.json` |
| Commit scope | `<word>` | `fix(web): …` |

Check a new command against Pi's built-in commands (type `/` in Pi) first. Pi adds numeric suffixes to duplicate names, so a second `/resume` would turn both into `/resume:1` and `/resume:2`.

When you rename something saved in a session, a settings file or the agent directory, keep reading the old name as a fallback and never rewrite or delete the user's old data.

## Pull requests

- Write commit messages as `type(scope): summary`, for example `fix(web): handle empty results`.
- Keep each pull request to one change.
- Update the package README when you change what a user sees or configures.

## Writing documentation

- A package README is for people using the extension: what it does, install, usage, commands, configuration and limitations, in that order.
- Put design explanation in the package's `docs/` folder, and contributor steps in this file.
- Use tables for settings and commands. Write in the present tense, without release history, test counts or dates.
- Add a Mermaid diagram only when it explains something a paragraph cannot.
