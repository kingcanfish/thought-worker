import { describe, expect, it } from "vitest";
import { addDays, dayKey, dayStart, isDayKey, timeOfDay, weekdayOf } from "../src/core/lib/time";

const utc = (...a: [number, number, number, number?]) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0) / 1000;

describe("time", () => {
  it("computes day start in Asia/Shanghai", () => {
    expect(dayStart("2026-09-29", "Asia/Shanghai")).toBe(utc(2026, 9, 28, 16));
  });

  it("handles DST transitions", () => {
    expect(dayStart("2026-03-08", "America/New_York")).toBe(utc(2026, 3, 8, 5));
    expect(dayStart("2026-03-09", "America/New_York")).toBe(utc(2026, 3, 9, 4));
  });

  it("formats day keys and time in the site tz", () => {
    const ts = utc(2026, 9, 28, 17); // 上海 9/29 01:00
    expect(dayKey(ts, "Asia/Shanghai")).toBe("2026-09-29");
    expect(timeOfDay(ts, "Asia/Shanghai")).toBe("01:00");
  });

  it("does day arithmetic and validation", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(weekdayOf("2026-09-29")).toBe(2);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-02-28")).toBe(true);
  });
});
