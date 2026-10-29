# Compare registrations before import

Requires AgentTCDH `0.1.2` or later. Build a source checkout and replace `agent-tcdh` below with `node dist/index.js` when working from source. See the [v0.1.2 release notes](releases/v0.1.2.md) for installation and publication checks.

## Compare a snapshot with the hub

```sh
agent-tcdh registry diff ./registry.json
agent-tcdh registry diff ./registry.json --on-conflict replace
agent-tcdh registry diff ./registry.json --on-conflict skip --details
```

Comparison validates the incoming snapshot, then reads current registrations through the normal read-only discovery API. It includes disabled entries and all discovery pages, so a read credential is sufficient; administrator-only registry export is not used. No import, update, deletion, remote metadata inspection, stdio launch, or tool/task execution takes place. The source file is unchanged.

Results are ordered by target ID and classify each observed registration:

| Status | Meaning |
| --- | --- |
| `added` | Incoming ID is absent from the hub |
| `changed` | The same ID has different definition fields |
| `unchanged` | Incoming and current definitions match |
| `retained` | The hub has an ID absent from the incoming collection; normal import keeps it |

Changed rows list affected fields: `name`, `description`, `protocol`, `tags`, `capabilities`, `connection`, and `enabled`. Comparison ignores export dates, server timestamps, and JSON object key order. Array order remains significant, including tags and capability arrays. It compares stored definitions, not current provider capabilities or actual execution.

By default, rows contain only IDs, status, and changed field names. `--details` adds full portable `current` and `incoming` definitions, uses `null` for an absent side, and forces JSON output. Normal redirected output is also JSON; `--json` selects it explicitly in a terminal. Detailed output contains registered/source metadata, which can include literal command arguments or URL values already present in a definition.

## Understand import conflicts

`counts` describes incoming/current totals and the four classifications. `conflicts` and `importReady` describe the selected existing import policy:

- `error` (default): every existing incoming ID conflicts, including an `unchanged` definition. `expectedImport` is `null` because the entire import would be rejected.
- `skip`: existing definitions are retained, including changed ones. `expectedImport` reports expected inserted/skipped counts.
- `replace`: every existing incoming ID is replaced. This includes unchanged definitions, which still receive new revisions under existing bulk-import behavior. Expected replacement counts include them.

IDs absent from the incoming collection are never deleted by these policies. The comparison command itself always reports `applied: false` and `executionVerified: false`. `registry diff` exits 0 when comparison succeeds, even when differences/conflicts are found; use its structured fields to make an automation decision. Invalid input, failed discovery, or an incomplete comparison exits 1.

## Compare existing configuration or a preset

```sh
agent-tcdh registry import-config ./config.toml --select docs --compare
agent-tcdh registry import-config ./config.toml --select docs --compare --on-conflict skip
agent-tcdh preset show public-docs --select openai-docs --compare
agent-tcdh preset import public-docs --select openai-docs --compare --on-conflict replace --details
```

These are opt-in online previews. Without `--compare`, [configuration imports and presets](config-import.md) retain their offline preview behavior. `--details` requires `--compare` for these commands. Do not combine `--compare` with `--apply`; run an actual import separately when ready. `--dry-run` can be combined with comparison on import commands.

Comparison uses the selected entries and any `--prefix`. Preparation warnings and omitted inline credential values remain visible in the outer report. A blocked/empty source preparation does not start registry comparison. A successful online preview adds `comparison`, sets `hubConflictsChecked: true`, and combines source validity with the selected policy's `importReady` in `ready`. Source errors or destination conflicts exit 1; a ready preview exits 0. Historical preset `metadataAsOf` dates are preserved; comparison does not claim a new provider observation.

The initial source preparation still includes its proposed `targets`. The comparison's default omission of full definitions applies to its rows, not to existing source-preview fields.

## Consistency and limits

The comparison is an advisory observation of paginated discovery, identified by `consistency: paginated-observation`. It detects changing totals, duplicate IDs, and incomplete pages and fails without returning a partial comparison. It is not a transactional snapshot: same-count concurrent edits may go undetected. No registration versions are locked and the comparison is not an approval token or a promise that a later import will succeed. An actual import checks its conflicts in its own transaction; replacement retains its existing unconditional bulk semantics.

Both collections use the existing snapshot limits: at most 10,000 targets and 16 MiB when serialized. Current registrations are read in pages of 100 with existing hub request timeouts. A registry exceeding these limits fails comparison rather than silently truncating results. Snapshot files require valid UTF-8 JSON; syntax/encoding diagnostics omit source values. Hub address and credential selection follow [guided setup](onboarding.md#credential-references).
