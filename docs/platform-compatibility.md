# Platform compatibility

AgentTCDH targets native Node.js 24 on Linux, macOS, and Windows. The hub uses Node's built-in SQLite, HTTP, filesystem, and path APIs. A native operating-system run is required to confirm a platform; inspecting branches or running a Linux container does not establish macOS or Windows compatibility.

## Verification status

Checked on 2026-10-27:

| Platform | Native Node version | Tests | Package installation / CLI / restart | Runner |
| --- | --- | --- | --- | --- |
| Linux x64 | 24.21.0 | 118 passed | Passed | `ubuntu-24.04` |
| macOS Apple Silicon | 24.20.0 | 118 passed | Passed | `macos-15` |
| macOS Intel | 24.19.0 | 118 passed | Passed | `macos-15-intel` |
| Windows x64 | 24.22.1 | 117 passed | Passed | `windows-2025` |

All five jobs in [the final native CI run](https://github.com/east-true/agent-tcdh/actions/runs/40477604438) completed successfully, including the independent Linux container job. The tested code commit is `ac2c7575e62332ddd7fd771e075a036fe00b8403`. Windows has one fewer test because the additional POSIX signal-handler test is replaced by the cross-platform IPC teardown check. No tests failed or were marked skipped within each platform's configured suite.

The [workflow](../.github/workflows/ci.yml) records the actual OS, architecture, and Node version and runs locked installation, typecheck, build, protocol regression, and isolated production-package verification on native runners. Docker runs as a separate Linux job. Local Linux verification also passed with Node.js 24.18.0. These results cover the recorded runner versions, including Windows Server 2025; they do not establish support for every historical OS release.

## Portability fixes

- Verification commands use an explicit `cross-spawn` development dependency to resolve Windows `.cmd` shims such as npm and npm-installed agent CLIs. Version checks and asynchronous calls share this handling. Commands and arguments remain separate; scripts do not concatenate unescaped shell commands.
- Owned verification process trees use POSIX process groups on Linux/macOS and `taskkill.exe /pid ... /t /f` on Windows. Successful termination is remembered, making repeated cleanup idempotent. Non-interactive command deadlines and output limits terminate their own process tree and preserve exit diagnostics.
- The local demo accepts an IPC `shutdown` message from an owning parent, permitting graceful teardown tests on Windows. Console SIGINT/SIGTERM handlers remain for applicable platforms. Windows `child.kill("SIGTERM")` is a forced termination and cannot validate a POSIX signal handler, so that additional signal test runs only on Linux/macOS.
- Tests check POSIX file mode bits only where meaningful. Snapshot contents, atomic creation, existing-file protection, replacement, and rollback checks still run on every platform. Windows filesystem permissions are governed by its ACLs.
- Temporary test directories are removed after per-test server/worker/SQLite teardown, avoiding deletion while Windows database handles remain open.
- The test-file glob is quoted so Node expands it consistently instead of relying on the invoking shell. Git attributes preserve LF source files and executable shebangs across checkouts.
- Demo entry detection compares canonical paths, allowing macOS temporary-directory aliases, symlinks, and Windows junctions. Non-file arguments to an importing eval program are ignored.
- The isolated package check deliberately installs into a path containing spaces. Additional tests exercise command shims, quoted/literal arguments, Unicode output, deadlines, and descendant-process cleanup.

## Failures found during native verification

The first native run exposed a macOS package-demo failure: the temporary-directory path contained a symlink alias, while Node canonicalized the module URL. Comparing the unresolved argument path made the script load as a library and exit without a result. Canonical path comparison fixed both example entry points, and a regression test now executes the demo and stdio target through a symlink or Windows junction.

A subsequent Intel macOS run exposed an `EPERM` failure when a teardown hook repeated process-group termination after successful cleanup. The command helper now tracks termination so repeated cleanup does not send another signal to the old process group. The final native run passed on both macOS architectures, Windows, Linux, and the Linux container. The [evidence record](evidence/platform-compatibility-20261027.json) retains links to the failed runs and their corrective commits.

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

## Evidence

- [Native CI run and all job results](https://github.com/east-true/agent-tcdh/actions/runs/40477604438)
- [Recorded runtimes, test counts, package outcomes, and earlier failures](evidence/platform-compatibility-20261027.json)
- [Verified code commit](https://github.com/east-true/agent-tcdh/commit/ac2c7575e62332ddd7fd771e075a036fe00b8403)

The report and JSON evidence were added after the verified code commit. Their documentation-only commit uses `[skip ci]`; the recorded native results apply to the exact source commit above.

## References

- [Node child-process platform behavior](https://nodejs.org/api/child_process.html)
- [Node test runner and quoted globs](https://nodejs.org/docs/latest-v24.x/api/test.html)
- [cross-spawn command resolution](https://github.com/moxystudio/node-cross-spawn)
- [GitHub native runner labels and architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
