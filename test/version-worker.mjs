import { parentPort, workerData } from "node:worker_threads";
import { TargetStore } from "../dist/targets/store.js";
import { parseIfMatch } from "../dist/targets/version.js";

const store = new TargetStore(workerData.path);

// Start concurrent conditional writes after both connections obtain the same version.
parentPort.once("message", () => {
  try {
    const result = store.updateVersioned(
      workerData.definition.id,
      { ...workerData.definition, name: workerData.name },
      parseIfMatch(workerData.etag),
    );
    parentPort.postMessage({ status: 200, name: result.target.name, etag: result.etag });
  } catch (error) {
    parentPort.postMessage({ status: error.statusCode ?? 500, message: error.message });
  } finally {
    store.close();
    parentPort.close();
  }
});
parentPort.postMessage({ ready: true });
