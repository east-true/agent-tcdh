# Remove a saved client connection

Requires AgentTCDH `0.1.3` or a source checkout containing this command. Version `0.1.2` does not include it. See the [v0.1.3 release notes](releases/v0.1.3.md) for candidate installation and separate publication checks.

Preview removing a named hub entry from an explicit client file, then apply the change:

```sh
npm run build
node dist/index.js disconnect cursor --file ./cursor-mcp.json
node dist/index.js disconnect cursor --file ./cursor-mcp.json --apply
node dist/index.js disconnect codex --file ./config.toml --name team_hub --json
```

All seven existing profiles are supported: `codex`, `opencode`, `opencode-v1`, `claude-code`, `gemini-cli`, `cursor`, and `vscode`. The default server entry name is `agent_tcdh`; use `--name` for another entry. The command removes that complete entry by name, including custom fields, even if it points to another hub or an old installation. It does not infer ownership from the entry's contents. Select the file, profile, and name deliberately.

## Preview and apply

The default and explicit `--dry-run` modes preview without writing files or backups. `--apply` enables removal. Do not combine `--apply` and `--dry-run`. A successful replacement uses the existing guarded configuration writer and saves the exact original bytes in a private backup beside the file. Other servers and unrelated settings are preserved. The configuration file itself remains present, even after removing its last server.

Application rereads the file and prepares a fresh removal; it is not bound to an earlier preview. The writer rejects a detected concurrent change during that application. A missing file or entry is a successful no-op: no file, directory, lock, or backup is created. Repeating a removal is safe.

The command uses only the selected file and entry name. It ignores `AGENT_TCDH_CONFIG`, hub URL defaults, credentials, and current bridge installation paths; explicit `--config`, `--hub`, and `--token-env` are rejected. Cleanup remains available when setup is missing or the hub is offline. It never contacts a hub, launches a bridge, executes targets, deletes registry registrations, uninstalls packages, stops running clients, or revokes credentials. Reload or restart the consuming client after applying the change.

## JSONC and TOML

JSON/JSONC removal edits the selected server path, retains the byte-order mark and surrounding text where supported by the JSONC editor, and validates that unrelated parsed values are unchanged. Invalid syntax and profile/container mismatches fail before a write.

Codex managed blocks created by `connect` are removed without rewriting the surrounding TOML when there is one unambiguous marker pair and the parsed result changes only the selected entry. CRLF line endings are supported. Marker-like text inside multiline strings cannot authorize deleting unrelated content: the parsed comparison must still pass.

For unmanaged tables, inline tables, or ambiguous markers, the report returns `normalization-required` and exit 1. Review a separate normalization preview before applying:

```sh
node dist/index.js disconnect codex --file ./config.toml --normalize
node dist/index.js disconnect codex --file ./config.toml --normalize --apply
```

`--normalize` allows TOML serialization, which can change formatting and remove comments. It preserves unrelated parsed values, checks the serialized result, and keeps an exact original backup when applied. Empty `mcp_servers` containers can be omitted. Other client profiles reject `--normalize`.

Malformed files, invalid UTF-8, symlinks, and files larger than 1 MiB are rejected. No personal configuration path is selected automatically.

## Reports

Terminal output is readable text; redirected output is JSON, as is explicit `--json`. Reports omit the source file contents, connection values, and credentials. They include the selected profile, file path, entry name, readiness, change/application flags, notes, and backup path when one was created.

| Reason | Meaning | Exit code |
| --- | --- | --- |
| `removal-ready` | A preview can remove the named entry | 0 |
| `removed` | The named entry was removed and a backup saved | 0 |
| `file-missing` | Nothing to remove; the file is absent | 0 |
| `entry-missing` | Nothing to remove; the named entry is absent | 0 |
| `normalization-required` | TOML needs an explicit `--normalize` choice | 1 |

Validation and write failures print diagnostics on stderr and exit 1. `hasChanges` identifies a prepared removal; `applied` and `changed` become true only after an actual replacement. `executionVerified` is always false because this operation edits local configuration only.

Use [saved connection checks](connection-check.md) to compare an entry with the current profile, or ordinary `connect --write FILE` to add it again.

Use [configuration restoration](configuration-restore.md) to preview restoring the complete pre-removal file from the returned backup. Applying a restore also backs up the current file.
