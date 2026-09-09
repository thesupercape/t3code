import { describe, expect, it } from "vite-plus/test";

import { shouldRegisterPwaServiceWorker } from "./registerPwaServiceWorker";

describe("shouldRegisterPwaServiceWorker", () => {
  it("registers only for production web clients with service-worker support", () => {
    expect(
      shouldRegisterPwaServiceWorker({
        production: true,
        electron: false,
        serviceWorkerSupported: true,
      }),
    ).toBe(true);
    expect(
      shouldRegisterPwaServiceWorker({
        production: false,
        electron: false,
        serviceWorkerSupported: true,
      }),
    ).toBe(false);
    expect(
      shouldRegisterPwaServiceWorker({
        production: true,
        electron: true,
        serviceWorkerSupported: true,
      }),
    ).toBe(false);
    expect(
      shouldRegisterPwaServiceWorker({
        production: true,
        electron: false,
        serviceWorkerSupported: false,
      }),
    ).toBe(false);
  });
});
