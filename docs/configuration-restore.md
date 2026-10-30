# Restore a configuration backup

This feature is unreleased and requires a source checkout containing `config restore`. Published `0.1.2` does not include it.

Use the backup path returned by `connect`, `disconnect`, or setup replacement to preview a whole-file restoration:

```sh
npm run build
node dist/index.js config restore ./config.toml.agent-tcdh-backup-UUID --file ./config.toml
node dist/index.js config restore ./config.toml.agent-tcdh-backup-UUID --file ./config.toml --apply
```

Replace the example backup name with the actual returned path. The source and destination must be explicit; the CLI does not choose a personal file or a newest backup automatically. `--dry-run` explicitly requests the default preview behavior. Do not combine it with `--apply`.

## What is restored

The operation restores the entire source text, including unrelated settings, comments, line endings, and a UTF-8 byte-order mark. It does not merge a single hub entry. Any settings added after the backup are replaced when applying; the current destination is retained in a new exact backup so that change can also be undone.

The source is a selected local UTF-8 file. The CLI does not verify that AgentTCDH created it or that it belongs to the destination, and it does not parse or validate client-specific syntax. All seven client profiles use the same restoration mechanism. This also permits recovering a malformed JSON/TOML destination or restoring a deliberately empty original file. Malformed UTF-8, symbolic links, non-regular files, and files larger than 1 MiB are rejected for both source and existing destination.

A missing source fails. A missing destination is created only with `--apply`; there is no previous file to back up in that case. A destination whose contents already match is a successful no-op with no writes, locks, or new backups. A source and destination with the same resolved path are rejected.

## Preview and application

A preview reports whether the contents differ, whether the destination exists, and the byte lengths of the two files. It never prints either file's contents, credential values, or a text diff. It leaves both files unchanged and creates no directories or backups.

Applying reads a fresh copy of the selected source and current destination. It is not bound to an earlier preview. The existing guarded configuration writer rejects detected concurrent destination changes during application, stages a private file, and saves the exact previous contents before replacing an existing destination. The selected source is not renamed, consumed, or removed.

The command ignores setup defaults, hub URL settings, and credentials, so it works while the hub is unavailable or personal setup is missing. Explicit `--config`, `--hub`, and `--token-env` are rejected. It does not contact a hub, start clients, execute targets, restore registry data, or recover environment variable values that were never stored in the file. Reload or restart the consuming application after restoration.

To undo the restoration, use the new backup path returned by the applied operation as the next source:

```sh
node dist/index.js config restore ./config.toml.agent-tcdh-backup-NEW-UUID --file ./config.toml
```

## Reports

Results are readable text in a terminal or JSON when redirected or requested with `--json`. They include `source`, destination `path`, `sourceBytes`, `destinationExists`, `destinationBytes` (null if missing), `hasChanges`, `applied`, `changed`, and the new `backup` path when an existing file was replaced.

| Reason | Meaning | Exit code |
| --- | --- | --- |
| `restore-ready` | The preview differs and can be applied | 0 |
| `restored` | The destination was written from the selected source | 0 |
| `unchanged` | The destination already matches; no write was needed | 0 |

Validation, missing-source, and write failures print diagnostics on stderr and exit 1. `executionVerified` is always false. A successful restore describes file replacement, not whether the client accepted or loaded the resulting configuration.

See [connection generation](onboarding.md), [connection checks](connection-check.md), and [named-entry removal](client-disconnection.md) for the related operations.
