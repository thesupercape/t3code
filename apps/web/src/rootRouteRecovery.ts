export const ROOT_ROUTE_RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export async function recoverRootRoute(input: {
  readonly refreshSessionState: () => void;
  readonly retryAuthBootstrap: () => Promise<unknown>;
  readonly invalidateRoute: () => Promise<unknown>;
  readonly resetBoundary: () => void;
}): Promise<void> {
  input.refreshSessionState();
  await input.retryAuthBootstrap();
  await input.invalidateRoute();
  input.resetBoundary();
}

/** Intentional testable boundary for bounded post-restart route recovery. */
export async function runBoundedRootRouteRecovery(input: {
  readonly recover: () => Promise<void>;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly isCancelled: () => boolean;
  readonly delays?: ReadonlyArray<number>;
}): Promise<boolean> {
  for (const delayMs of input.delays ?? ROOT_ROUTE_RECOVERY_DELAYS_MS) {
    await input.wait(delayMs);
    if (input.isCancelled()) return false;
    try {
      await input.recover();
      return true;
    } catch {
      // The next bounded attempt gets fresh auth and route state.
    }
  }
  return false;
}
