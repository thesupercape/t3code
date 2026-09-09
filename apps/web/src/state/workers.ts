import { createWorkerEnvironmentAtoms } from "@t3tools/client-runtime/state/workers";

import { connectionAtomRuntime } from "../connection/runtime";

export const workerEnvironment = createWorkerEnvironmentAtoms(connectionAtomRuntime);
