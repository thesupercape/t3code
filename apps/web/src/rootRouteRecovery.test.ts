import { describe, expect, it, vi } from "vite-plus/test";

import { recoverRootRoute, runBoundedRootRouteRecovery } from "./rootRouteRecovery";

describe("root route recovery", () => {
  it("invalidates failed auth and route state when Try again is used", async () => {
    const calls: Array<string> = [];
    await recoverRootRoute({
      refreshSessionState: () => calls.push("refresh-session-atom"),
      retryAuthBootstrap: async () => void calls.push("retry-auth-bootstrap"),
      invalidateRoute: async () => void calls.push("invalidate-route"),
      resetBoundary: () => calls.push("reset-boundary"),
    });

    expect(calls).toEqual([
      "refresh-session-atom",
      "retry-auth-bootstrap",
      "invalidate-route",
      "reset-boundary",
    ]);
  });

  it("automatically recovers after a failed bootstrap without looping", async () => {
    const recover = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("backend restarting"))
      .mockResolvedValue(undefined);
    const wait = vi.fn(async () => undefined);

    await expect(
      runBoundedRootRouteRecovery({
        recover,
        wait,
        isCancelled: () => false,
        delays: [1_000, 2_000, 4_000],
      }),
    ).resolves.toBe(true);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it("stops after the bounded attempts when the backend remains unavailable", async () => {
    const recover = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("offline"));
    await expect(
      runBoundedRootRouteRecovery({
        recover,
        wait: async () => undefined,
        isCancelled: () => false,
        delays: [1, 2],
      }),
    ).resolves.toBe(false);
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
