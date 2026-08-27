import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { summarizeDoctor, worstOf } from "../src/lib/doctorSummary.ts";

const check = (severity: DoctorCheck["severity"]): DoctorCheck => ({
  name: "c",
  severity,
  message: "m",
});

describe("summarizeDoctor", () => {
  it("all clear when every check is ok", () => {
    expect(summarizeDoctor([check("ok"), check("ok")])).toEqual({
      failing: 0,
      warnings: 0,
      text: "all clear",
      tone: "receipt",
    });
  });

  it("warnings only", () => {
    expect(summarizeDoctor([check("ok"), check("warn")])).toMatchObject({
      warnings: 1,
      text: "1 warning",
      tone: "spend",
    });
    expect(summarizeDoctor([check("warn"), check("warn")]).text).toBe("2 warnings");
  });

  it("failing wins the tone and names both counts", () => {
    expect(summarizeDoctor([check("fail"), check("warn"), check("warn")])).toMatchObject({
      failing: 1,
      warnings: 2,
      text: "1 failing · 2 warnings",
      tone: "blocked",
    });
    expect(summarizeDoctor([check("fail")]).text).toBe("1 failing · 0 warnings");
  });

  it("undefined and empty inputs read as all clear (loading states render separately)", () => {
    expect(summarizeDoctor(undefined).text).toBe("all clear");
    expect(summarizeDoctor([]).text).toBe("all clear");
  });
});

describe("worstOf", () => {
  it("fail > warn > ok", () => {
    expect(worstOf([check("ok"), check("warn"), check("fail")])).toBe("fail");
    expect(worstOf([check("ok"), check("warn")])).toBe("warn");
    expect(worstOf([check("ok")])).toBe("ok");
    expect(worstOf([])).toBe("ok");
  });
});
