/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { USAGE_CONTRACT_VERSION, UsageDay, type UsageSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: "This environment could not report usage." as string | null,
      summary: null as UsageSummary | null,
    },
  ],
  execute: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (...args: unknown[]) => state.execute(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("./server", () => ({
  serverEnvironment: { usageSummary: (request: unknown) => request },
}));

import { useUsage } from "./usage";

function UsageProbe() {
  useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return null;
}

const refreshedSummary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-01T12:00:00.000Z",
  timeZone: "America/Chicago",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-09-01"),
  buckets: [],
  sources: [],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
};

const deferredSummary: UsageSummary = {
  ...refreshedSummary,
  sources: [
    {
      fingerprint: {
        hostId: "desktop",
        provider: "codex",
        resolvedHomePath: "/sessions",
        volumeId: "1",
      },
      status: "partial",
      scannedFiles: 1,
      skippedFiles: 2,
      malformedRecords: 0,
      distinctSessions: 1,
      message: "2 older or oversized transcript files deferred",
    },
  ],
};

function RefreshProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button type="button" onClick={() => void usage.refresh()}>
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function RefreshStatusesProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <div>
      <button type="button" onClick={() => void usage.refresh()}>
        refresh
      </button>
      {usage.environments.map((environment) => (
        <span key={environment.environmentId}>
          {environment.environmentId}:
          {environment.summary?.readAt ?? environment.error ?? "pending"}
        </span>
      ))}
    </div>
  );
}

function RefreshDifferentWindowProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button
      type="button"
      onClick={() =>
        void usage.refresh({
          sinceDay: UsageDay.make("2026-08-02"),
          untilDay: UsageDay.make("2026-09-01"),
          timeZone: "America/Chicago",
        })
      }
    >
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function RetainPreviousProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button type="button" onClick={() => void usage.refresh()}>
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function DifferentWindowResultProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  const [readAt, setReadAt] = useState("pending");
  return (
    <button
      type="button"
      onClick={() =>
        void usage
          .refresh({
            sinceDay: UsageDay.make("2026-08-02"),
            untilDay: UsageDay.make("2026-09-01"),
            timeZone: "America/Chicago",
          })
          .then((statuses) => setReadAt(statuses[0]?.summary?.readAt ?? "missing"))
      }
    >
      {readAt}
    </button>
  );
}

beforeEach(() => {
  state.environments = [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: "This environment could not report usage.",
      summary: null,
    },
  ];
  state.execute
    .mockReset()
    .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
});

describe("usage route recovery", () => {
  it("retries a retained environment failure once when the route mounts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
      expect(state.execute.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          input: expect.objectContaining({ refresh: true }),
        }),
      );
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("adopts the result fetched by a manual refresh", async () => {
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RefreshProbe />));
      await act(async () => container.querySelector("button")?.click());
      expect(container.textContent).toBe(refreshedSummary.readAt);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the last successful summary visible when a refresh disconnects", async () => {
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RetainPreviousProbe />));
      await act(async () => container.querySelector("button")?.click());
      expect(container.textContent).toBe(refreshedSummary.readAt);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not carry same-environment totals into a failed different-window refresh", async () => {
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DifferentWindowResultProbe />));
      await act(async () => container.querySelector("button")?.click());
      expect(container.textContent).toBe("missing");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps one delayed retry alive while a remote connection recovers", async () => {
    vi.useFakeTimers();
    state.execute
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("disconnected"))))
      .mockResolvedValue(AsyncResult.success(refreshedSummary));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(state.execute).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("does not retry a failure while the original query is still pending", async () => {
    vi.useFakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: true,
        error: "This environment could not report usage.",
        summary: null,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(state.execute).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("coalesces a delayed retry with an active same-window refresh", async () => {
    vi.useFakeTimers();
    let finish!: (result: unknown) => void;
    state.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(state.execute).toHaveBeenCalledTimes(1);

      await act(async () => {
        finish(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(state.execute).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("bounds retries when the deferred retry also fails slowly", async () => {
    vi.useFakeTimers();
    const finishers: Array<(result: unknown) => void> = [];
    state.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishers.push(resolve);
        }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(state.execute).toHaveBeenCalledTimes(1);

      await act(async () => {
        finishers[0]?.(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(state.execute).toHaveBeenCalledTimes(2);

      await act(async () => {
        finishers[1]?.(AsyncResult.failure(Cause.fail(new Error("still disconnected"))));
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(30_000);
      });
      expect(state.execute).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("backs off and stops after five deferred scans make no progress", async () => {
    vi.useFakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: deferredSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.success(deferredSummary));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      for (const delay of [750, 1_500, 3_000, 6_000, 8_000]) {
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      expect(state.execute).toHaveBeenCalledTimes(5);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(state.execute).toHaveBeenCalledTimes(5);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("keeps warming a large deferred backlog while its count decreases", async () => {
    vi.useFakeTimers();
    let deferredCount = 30;
    const summaryForCount = (count: number): UsageSummary => ({
      ...deferredSummary,
      sources: [
        {
          ...deferredSummary.sources[0]!,
          skippedFiles: count,
          message: `${count} older or oversized transcript files deferred`,
        },
      ],
    });
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: summaryForCount(deferredCount),
      },
    ];
    state.execute.mockImplementation(async () => {
      deferredCount -= 1;
      return AsyncResult.success(
        deferredCount > 0 ? summaryForCount(deferredCount) : refreshedSummary,
      );
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await act(async () => vi.advanceTimersByTimeAsync(750));
      }
      expect(state.execute).toHaveBeenCalledTimes(30);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(state.execute).toHaveBeenCalledTimes(30);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled deferred retry when the environment fails", async () => {
    vi.useFakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: deferredSummary,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      state.execute.mockClear();
      state.environments = [
        {
          environmentId: "desktop",
          label: "Desktop",
          isPending: false,
          error: "This environment could not report usage.",
          summary: deferredSummary,
        },
      ];
      await act(async () => root.render(<UsageProbe />));
      state.execute.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(
        state.execute.mock.calls.filter(
          ([, request]) => (request as { input?: { refresh?: boolean } }).input?.refresh === false,
        ),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("allows a newer shared answer to replace the manual refresh overlay", async () => {
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RefreshProbe />));
      await act(async () => container.querySelector("button")?.click());
      expect(container.textContent).toBe(refreshedSummary.readAt);

      state.environments = [
        {
          environmentId: "desktop",
          label: "Desktop",
          isPending: false,
          error: null,
          summary: { ...refreshedSummary, readAt: "2026-09-01T12:01:00.000Z" },
        },
      ];
      await act(async () => root.render(<RefreshProbe />));
      expect(container.textContent).toBe("2026-09-01T12:01:00.000Z");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("publishes fast environment results while a slower refresh is pending", async () => {
    let finishSlow!: (result: unknown) => void;
    const slow = new Promise((resolve) => {
      finishSlow = resolve;
    });
    const quickSummary = { ...refreshedSummary, readAt: "2026-09-01T12:02:00.000Z" };
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
      {
        environmentId: "laptop",
        label: "Laptop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    state.execute.mockImplementation((_registry: unknown, request: { environmentId: string }) =>
      request.environmentId === "desktop"
        ? Promise.resolve(AsyncResult.success(quickSummary))
        : slow,
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RefreshStatusesProbe />));
      await act(async () => container.querySelector("button")?.click());
      await act(async () => Promise.resolve());
      expect(container.textContent).toContain("desktop:2026-09-01T12:02:00.000Z");
      expect(container.textContent).toContain("laptop:pending");

      finishSlow(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
      await act(async () => slow);
      state.environments = [
        {
          environmentId: "laptop",
          label: "Laptop",
          isPending: false,
          error: null,
          summary: { ...refreshedSummary, readAt: "2026-09-01T12:03:00.000Z" },
        },
        state.environments[0]!,
      ];
      await act(async () => root.render(<RefreshStatusesProbe />));
      expect(container.textContent).toContain("laptop:2026-09-01T12:03:00.000Z");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not show the old window while refreshing a different request key", async () => {
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RefreshDifferentWindowProbe />));
      const button = container.querySelector("button")!;
      await act(async () => button.click());
      expect(button.textContent).toBe(refreshedSummary.readAt);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
