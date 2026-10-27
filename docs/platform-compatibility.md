# Platform compatibility

AgentTCDH targets native Node.js 24 on Linux, macOS, and Windows. The hub uses Node's built-in SQLite, HTTP, filesystem, and path APIs. A native operating-system run is required to confirm a platform; inspecting branches or running a Linux container does not establish macOS or Windows compatibility.

## Verification status

Checked on 2026-10-27:

| Platform | Native execution status | Configured CI runner |
| --- | --- | --- |
| Linux x64 | Typecheck and all 116 tests passed; isolated package installation, CLI, protocols, restart persistence, and direct local demo passed | `ubuntu-24.04` |
| macOS Apple Silicon | Pending native CI execution | `macos-15` |
| macOS Intel | Pending native CI execution | `macos-15-intel` |
| Windows x64 | Pending native CI execution | `windows-2025` |

The observed host was Linux x64 with Node.js 24.18.0. The [workflow](../.github/workflows/ci.yml) now runs the same regression and isolated package checks on all four runners, records the actual OS/architecture/Node version, and lets independent jobs finish if another platform fails. Docker checks remain a separate Linux job. A configured matrix is not evidence of a successful run. At the time of this report, these project changes had not been pushed and no native macOS/Windows CI results were available.

## Portability fixes

- Verification commands use an explicit `cross-spawn` development dependency to resolve Windows `.cmd` shims such as npm and npm-installed agent CLIs. Version checks and asynchronous calls share this handling. Commands and arguments remain separate; scripts do not concatenate unescaped shell commands.
- Owned verification process trees use POSIX process groups on Linux/macOS and `taskkill.exe /pid ... /t /f` on Windows. Non-interactive command deadlines and output limits terminate their own process tree and preserve exit diagnostics.
- The local demo accepts an IPC `shutdown` message from an owning parent, permitting graceful teardown tests on Windows. Console SIGINT/SIGTERM handlers remain for applicable platforms. Windows `child.kill("SIGTERM")` is a forced termination and cannot validate a POSIX signal handler, so that additional signal test runs only on Linux/macOS.
- Tests check POSIX file mode bits only where meaningful. Snapshot contents, atomic creation, existing-file protection, replacement, and rollback checks still run on every platform. Windows filesystem permissions are governed by its ACLs.
- Temporary test directories are removed after per-test server/worker/SQLite teardown, avoiding deletion while Windows database handles remain open.
- The test-file glob is quoted so Node expands it consistently instead of relying on the invoking shell. Git attributes preserve LF source files and executable shebangs across checkouts.
- The isolated package check deliberately installs into a path containing spaces. Additional tests exercise command shims, quoted/literal arguments, Unicode output, deadlines, and descendant-process cleanup.

## Run locally

The basic commands are the same in bash, zsh, PowerShell, or Command Prompt:

```text
npm ci
npm run check
npm run test:package
npm run demo
npm run demo -- --discovery a2a
```

Use Node.js 24 with its matching native architecture. If a PowerShell policy blocks npm's `.ps1` shim, run these commands as `npm.cmd ...` or use Command Prompt.

Environment assignment follows the shell. For example, configure the hub URL before invoking the CLI:

```sh
# bash / zsh
export AGENT_TCDH_URL=http://127.0.0.1:3000
npm run cli -- target list
```

```powershell
# PowerShell
$env:AGENT_TCDH_URL = "http://127.0.0.1:3000"
npm run cli -- target list
```

```bat
:: Command Prompt
set "AGENT_TCDH_URL=http://127.0.0.1:3000"
npm run cli -- target list
```

## Boundaries

Remote HTTP MCP and A2A definitions use the same schema across operating systems. Local stdio commands, executable locations, arguments, and environment references must work in the consuming agent's environment. A registration containing a Linux-only path is not made portable merely by moving the registry. Use JSON-escaped backslashes in Windows paths, or forward slashes where the target program accepts them. The local demo derives its Node executable and script paths from the current environment.

SQLite and atomic snapshot export require suitable filesystem semantics. In particular, non-overwriting snapshot creation uses a hard link on the destination filesystem. Keep this behavior on a filesystem that supports hard links; the application does not fall back to a non-atomic overwrite. FAT/exFAT and network filesystems need separate evaluation.

Public-provider and real-model checks remain opt-in and are not automatically exercised by this OS matrix. The earlier Gemini, Jev, and Codex live-call evidence was obtained on Linux. Other OSes additionally require their agent CLIs, credentials, target services, and permissions. WSL is a Linux execution environment, and Docker Desktop runs the Linux container image; neither is evidence of native Windows hub execution.

## References

- [Node child-process platform behavior](https://nodejs.org/api/child_process.html)
- [Node test runner and quoted globs](https://nodejs.org/docs/latest-v24.x/api/test.html)
- [cross-spawn command resolution](https://github.com/moxystudio/node-cross-spawn)
- [GitHub native runner labels and architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
