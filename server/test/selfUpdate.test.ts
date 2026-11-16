import { describe, expect, it } from "vitest";
import { shouldHandOver } from "../src/domain/selfUpdate.js";

describe("shouldHandOver", () => {
  it.each([
    ["nothing staged", { running: "a", staged: null, playing: false }, false],
    ["staged is what's running", { running: "a", staged: "a", playing: false }, false],
    ["new build, someone watching", { running: "a", staged: "b", playing: true }, false],
    ["new build, idle", { running: "a", staged: "b", playing: false }, true],
    ["baked image (no commit), idle", { running: null, staged: "b", playing: false }, true],
  ] as const)("%s → %s", (_, f, want) => expect(shouldHandOver(f)).toBe(want));
});
