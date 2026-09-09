import { describe, expect, it } from "vite-plus/test";
import type { ResetCheckState } from "@t3tools/contracts";
import { latestResetCheck, resetCheckPresentation } from "./resetCheckPresentation.ts";

const running: ResetCheckState = {
  status: "running",
  startedAt: "2026-08-30T23:00:00Z",
  finishedAt: null,
  result: null,
  error: null,
};
const completed: ResetCheckState = {
  ...running,
  status: "completed",
  finishedAt: "2026-08-30T23:01:00Z",
};

describe("reset-check presentation", () => {
  it("keeps a completed command reply when an older poll arrives", () => {
    expect(latestResetCheck(running, completed)).toEqual(completed);
  });
  it("accepts a newer job started on another device", () => {
    const newer = { ...running, startedAt: "2026-08-30T23:02:00Z" };
    expect(latestResetCheck(newer, completed)).toEqual(newer);
  });
  it("restores the server result without a local command", () => {
    expect(latestResetCheck(completed, null)).toEqual(completed);
    expect(latestResetCheck(null, completed)).toEqual(completed);
  });
  it("formats a saved check timestamp without inventing a result", () => {
    expect(resetCheckPresentation(completed).checked).toBeTruthy();
    expect(resetCheckPresentation(completed).title).toBeNull();
    expect(resetCheckPresentation(null).range).toBeNull();
  });
});
