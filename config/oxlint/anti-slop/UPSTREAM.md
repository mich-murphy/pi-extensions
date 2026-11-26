# Vendored anti-slop Oxlint plugins

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
[`63dbb09`](https://github.com/dmmulroy/anti-slop/commit/63dbb09f73438e550a6991dc6d778f979ffbf183).

The generic and Effect entry points are `index.ts` and `effect/index.ts`.
The vendored source files stay byte-identical to upstream. The `*.test.ts`
files are omitted because they depend on the upstream test harness.

The base lint config is `@cloudflare/oxlint-config`. Its `quality` plugin
provides 12 rules from anti-slop. The vendored plugins supply only the rules
that the preset lacks:

| Plugin | Enabled rules |
| --- | --- |
| `anti-slop` | `no-module-mocking`, `no-runtime-typeof`, `no-shape-in-symbol-names`, `no-unknown-parameters`, `require-readable-spacing`, `require-safety-comment-for-type-assertion` |
| `anti-slop-effect` | `no-manual-effect-error-tag`, `no-manual-tag-comparison`, `no-manual-tagged-construction`, `no-service-constructor-imports`, `prefer-effect-match` |

When updating either the preset or the vendored plugins, enable new rules
and fix their findings in the same change.
