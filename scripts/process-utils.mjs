import crossSpawn from "cross-spawn";

/** Resolve native executables and Windows command shims while preserving argument boundaries. */
export function spawnCommand(command, args, options = {}) {
  return crossSpawn(command, args, { windowsHide: true, ...options });
}

/** Query a CLI version using the same portable command resolution as asynchronous runs. */
export function commandVersion(command, timeout = 10_000) {
  const result = crossSpawn.sync(command, ["--version"], { encoding: "utf8", timeout, windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(command + " --version failed with exit code " + result.status);
  }
  return result.stdout.trim();
}

/** Stop an owned child process tree using Windows taskkill or its POSIX process group. */
export function stopProcessTree(child, force = false) {
  if (!child?.pid) {
    return;
  }
  if (process.platform === "win32") {
    const result = crossSpawn.sync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true, stdio: "ignore",
    });
    if (result.error && result.error.code !== "ESRCH") {
      throw result.error;
    }
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

/** Capture bounded command output with a deadline and compatible Windows shim handling. */
export function runCommand(command, args, options = {}) {
  const { timeout = 120_000, maxBuffer = 4_194_304, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    // 1. Own the child process tree and keep stdin closed for non-interactive commands.
    const child = spawnCommand(command, args, { ...spawnOptions,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => fail(new Error("Command timed out: " + command)), timeout);

    /** Retain the first transport failure and terminate only the owned process tree. */
    function fail(error) {
      failure ??= error;
      stopProcessTree(child, true);
    }

    /** Enforce the combined output limit before accepting another output chunk. */
    function capture(chunk, stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) {
        fail(new Error("Command output exceeded the byte limit: " + command));
        return;
      }
      if (stream === "stdout") {
        stdout += chunk;
      } else {
        stderr += chunk;
      }
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => {
      failure ??= error;
    });

    // 2. Preserve diagnostics and numeric exit codes used by deployment checks.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        const error = failure ?? new Error("Command failed: " + command + " (exit " + code + ")");
        Object.assign(error, { code: failure?.code ?? code, signal, stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
