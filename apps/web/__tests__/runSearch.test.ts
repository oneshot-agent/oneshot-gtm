import { expect, it } from "vitest";
import { defaultParseSearch } from "@tanstack/react-router";
import { validateRunSearch } from "../src/lib/runSearch.ts";

it("loads approved rows from the actual browser URL", () => {
  expect(validateRunSearch(defaultParseSearch("?fromQueue=1&limit=100"))).toEqual({
    fromQueue: "1",
    limit: 100,
  });
});
it("preserves queue flags from internal navigation", () => {
  expect(validateRunSearch({ fromQueue: "1", dryRun: "0" })).toEqual({
    fromQueue: "1",
    dryRun: "0",
  });
});
it("keeps a single selected queue row rather than widening to all rows", () => {
  expect(validateRunSearch(defaultParseSearch("?fromQueue=1&ids=42&dryRun=1"))).toEqual({
    fromQueue: "1",
    ids: [42],
    dryRun: "1",
  });
});
it("keeps empty or invalid selections empty", () => {
  for (const query of ["?ids=", "?ids=abc", "?ids=true", "?ids=%5B42%5D"])
    expect(validateRunSearch(defaultParseSearch(query)).ids).toEqual([]);
});
