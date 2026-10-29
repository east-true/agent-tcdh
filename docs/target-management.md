# Manage existing registrations

These commands are available from source on `main` for the next release. Published npm `0.1.1` does not include the new edit/state commands or removal previews. Build the checkout and replace `agent-tcdh` below with `node dist/index.js` when working from source.

## Edit labels and tags without a JSON file

```sh
agent-tcdh target edit openai-docs --name "OpenAI documentation" --add-tag team-docs --dry-run
agent-tcdh target edit openai-docs --name "OpenAI documentation" --add-tag team-docs
agent-tcdh target edit openai-docs --description "Official API documentation" --remove-tag old-label
```

`target edit` updates only `name`, `description`, and tags. At least one change option is required. Repeat `--add-tag` or `--remove-tag` for multiple tags. Values are trimmed using the definition schema; tag comparisons are case-sensitive. Removal deletes every exact matching occurrence. Surviving tags keep their order, and new tags are appended once in request order. Adding an existing tag or removing an absent tag is a no-op. Adding and removing the same normalized tag in one command is rejected.

The final definition must still satisfy existing limits, including at most 50 tags. Protocol, connection/authentication references, capabilities, and enabled state are preserved. To change a connection, protocol, or capability list, use the existing full-definition `target update ID FILE` or remote metadata refresh commands.

Without `--dry-run`, a valid edit is applied immediately, matching existing target administration commands. Preview performs a versioned read of the hub, not an offline estimate. It does not probe the registered provider or launch a command. Applying changes uses administrator credentials; previews use the normal registry read credential selection. See [setup credential precedence](onboarding.md#credential-references).

## Temporarily exclude a target from discovery

```sh
agent-tcdh target disable openai-docs --dry-run
agent-tcdh target disable openai-docs
agent-tcdh target list --include-disabled
agent-tcdh target enable openai-docs
```

These commands change only `enabled`. Disabled registrations disappear from default searches and remain visible through direct `get_target`/`target get` and searches with `includeDisabled`. Disabling is a discovery setting: it does not revoke provider permissions, invalidate previously returned connection details, or cancel work in a consuming agent.

An operation already satisfied by the observed registration skips the write. Its ETag and timestamps remain unchanged. Other non-empty edits continue to use the existing server update behavior.

## Review changes and protect against concurrent edits

Edit/state reports include:

- `id` and `action`: the selected registration and operation.
- `dryRun`, `hasChanges`, and `applied`: whether differences were found and a write completed.
- `baseVersion`: the ETag read before preparing the edit.
- `changes`: before/after values for modified administrator fields.
- `target`: the proposed portable definition, without server-managed timestamps.

All new edit/state writes automatically use `baseVersion` in `If-Match`. A concurrent change or deletion causes a failure instead of overwriting it. There is no automatic retry. The report describes the observed/proposed definition; `baseVersion` is not a post-write version. Use `target get ID --with-version` to read a later version.

For a separate preview and apply to require the same reviewed version, pass the preview's actual `baseVersion` using `--if-match`:

```sh
agent-tcdh target edit openai-docs --add-tag team-docs --dry-run --json
agent-tcdh target edit openai-docs --add-tag team-docs --if-match '"actual-preview-revision"'
```

Replace the example ETag, including its quotes, with the value returned by your preview. Without a caller condition, a later apply command reads the latest registration and prepares a fresh edit. Caller conditions also gate previews and no-ops. The existing strong ETag list/wildcard syntax is accepted; actual writes remain pinned to the single version observed by that command. Weak tags cannot satisfy a condition.

New commands show readable summaries in a terminal. Redirected output is JSON; `--json` explicitly selects JSON. Validation, lookup, permission, and version failures exit with code 1. Applied changes, no-ops, and valid previews exit with code 0. Credential environment values are not inserted into the report; its target metadata is the registered/proposed definition.

## Preview removal

```sh
agent-tcdh target remove openai-docs --dry-run --json
agent-tcdh target remove openai-docs --if-match '"actual-preview-revision"'
```

Removal preview reads exactly one existing registration and returns `dryRun: true`, `applied: false`, its portable `target`, and `baseVersion`. It does not delete, disable, or contact that target. Pass its version to the existing deletion command to ensure the reviewed registration has not changed. A missing target fails instead of inventing a deletion plan.

Existing `target remove` without `--dry-run` retains its original result shape and behavior: it deletes immediately, and `--if-match` is optional. The original full-definition `target update` also keeps its existing optional version behavior. No HTTP/MCP/A2A schema, database schema, or snapshot format changes are required.
