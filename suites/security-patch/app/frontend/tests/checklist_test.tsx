import { test } from "bun:test";
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { ChecklistSidebar, displaySteps } from "../src/components/ChecklistSidebar.tsx";
import { markup } from "./render.tsx";
import type { StepProgress } from "../src/types/events.ts";

test("steps behind the furthest step show as done or skipped, and only that step shows stopped", () => {
  // A resumed fix run that paused in review: scan never reported done.
  const steps = (["completed", "completed", "pending", "in_progress", "completed", "in_progress", "pending", "pending"] as const)
    .map((status, i) => ({ name: `s${i}`, status }) as unknown as StepProgress);
  assertEquals(displaySteps(steps, true),
    ["completed", "completed", "skipped", "completed", "completed", "stopped", "pending", "pending"]);
  assertEquals(displaySteps(steps, false)[5], "in_progress");
});

test("the progress bar exposes its value", () => {
  const steps = [{ name: "scan", status: "completed" }, { name: "triage", status: "pending" }] as unknown as StepProgress[];
  const html = markup(<ChecklistSidebar steps={steps} />);
  const bar = html.match(/<div[^>]*role="progressbar"[^>]*>/)?.[0] ?? "";
  assertEquals(bar.match(/aria-valuenow="(\d+)"/)?.[1], "50");
  const labelId = bar.match(/aria-labelledby="([^"]+)"/)?.[1] ?? "";
  assertEquals(html.includes(`id="${labelId}"`) && labelId !== "", true);
});
