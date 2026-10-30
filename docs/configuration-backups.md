# Find configuration backups

This feature is unreleased and requires a source checkout containing `config backups`. Published `0.1.2` does not include it.

List backups associated with an explicit configuration path:

```sh
npm run build
node dist/index.js config backups --file ./config.toml
node dist/index.js config backups --file ./config.toml --limit 50 --json
```

The command lists sibling entries matching the exact destination basename plus `.agent-tcdh-backup-` and a version-4 UUID, the convention used by setup replacement, `connect`, `disconnect`, and `config restore`. It does not search recursively or include arbitrary copied/renamed backups. On Windows, the filename prefix comparison ignores case; on other platforms it uses the supplied spelling. Naming is a discovery filter, not proof of ownership or origin.

The destination does not have to exist and its contents are never read. A missing parent or no matching entries returns an empty successful result without creating directories. Setup defaults, hub URLs, credentials, and `AGENT_TCDH_CONFIG` are ignored. Explicit `--config`, `--hub`, and `--token-env` are rejected, as are write/apply options.

## Ordering and limits

Results use filesystem modification time, newest first; ties use path order. This is not an immutable creation history: editing or copying a backup can change its modification time. Unavailable metadata sorts last.

The default result limit is 20; `--limit` accepts integers from 1 through 100. The command scans the parent directory and sorts all matching observations before applying the result limit. `total` counts all matching entries observed, including unsupported entries. `truncated` indicates that some matches were omitted from the returned items. A scan exceeding 10,000 directory entries fails without returning a partial listing; the cap includes unrelated entries.

The listing is not an atomic directory snapshot. Concurrent additions can be missed, and a file that disappears or cannot be inspected can appear as `unavailable`. A later restore preview reads its selected source again.

## Metadata status

The command reads directory entries and file metadata only. It never opens backup contents, prints source values, or verifies client syntax or UTF-8 contents.

| Status | Meaning | Restore preview command |
| --- | --- | --- |
| `candidate` | A regular file no larger than 1 MiB was observed | Included |
| `too-large` | The file exceeds the restoration size bound | Omitted |
| `unsupported-file` | The entry is a directory, symbolic link, or other unsupported type | Omitted |
| `unavailable` | File metadata could not be inspected | Omitted |

A `candidate` has not passed restoration validation. For example, a file with invalid UTF-8 can be listed as a candidate while its restore preview fails. Symlink metadata is inspected without following the link. The report includes each matched path, size, modification time, and status; unavailable size/time values are null.

## Preview a restoration

Candidate entries include a `restoreCommand` argument array that invokes this installation through its absolute Node executable and CLI path. Terminal output renders that array for the current platform's shell. The generated command selects the exact source and destination and always previews; it never includes `--apply`. Paths belong to this machine and installation. Refresh the listing after moving the package or changing runtimes.

Run the displayed command to validate the source and compare it with the destination. If paths contain terminal controls, human output shows JSON arguments instead of a shell command. JSON output always retains structured arguments. Source checkouts can also use the ordinary CLI directly:

```sh
node dist/index.js config restore ./config.toml.agent-tcdh-backup-ACTUAL-UUID --file ./config.toml
```

Only a separate explicit `--apply` restores the whole file and backs up its current contents. See [configuration restoration](configuration-restore.md) for replacement scope and validation.

Output is readable in a terminal or JSON when redirected or requested with `--json`. The report includes `items`, `total`, `limit`, `truncated`, and `scannedEntries`. `metadataOnly` is true; `changed` and `executionVerified` are false. Listing never writes, deletes, restores, or contacts a hub. Empty results exit 0; invalid options, directory failures, and the scan cap exit 1.
