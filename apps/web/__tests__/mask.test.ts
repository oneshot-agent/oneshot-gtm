import { describe, expect, it } from "vitest";
import {
  applyMask,
  maskAuto,
  maskByKind,
  maskCompany,
  maskEmail,
  maskFrom,
  maskName,
  maskPhone,
} from "../src/lib/mask.ts";

describe("maskName", () => {
  it("keeps the first name and reduces the rest to initials", () => {
    expect(maskName("Asad Hussain")).toBe("Asad H.");
    expect(maskName("Mary Jane Watson")).toBe("Mary J. W.");
  });
  it("keeps a single-token name as-is", () => {
    expect(maskName("Asad")).toBe("Asad");
  });
  it("collapses surrounding and internal whitespace", () => {
    expect(maskName("  Asad   Hussain  ")).toBe("Asad H.");
  });
  it("uppercases the initial of a lowercase surname", () => {
    expect(maskName("asad hussain")).toBe("asad H.");
  });
  it("handles a hyphenated surname as a single token", () => {
    expect(maskName("Mary Smith-Jones")).toBe("Mary S.");
  });
  it("returns empty for null/empty/whitespace-only", () => {
    expect(maskName(null)).toBe("");
    expect(maskName("")).toBe("");
    expect(maskName("   ")).toBe("");
  });
});

describe("maskEmail", () => {
  it("keeps a 3-char hint of the local part and the full domain", () => {
    expect(maskEmail("asadhussain2408@gmail.com")).toBe("asa•••@gmail.com");
  });
  it("keeps only the first char when the local part is short", () => {
    expect(maskEmail("jo@x.com")).toBe("j•••@x.com");
  });
  it("masks a non-address string past the first 3 chars", () => {
    expect(maskEmail("notanemail")).toBe("not•••");
    expect(maskEmail("ab")).toBe("a•••");
  });
  it("preserves case and keeps the full domain incl. subdomains", () => {
    expect(maskEmail("Asad@Mail.Acme.CO")).toBe("Asa•••@Mail.Acme.CO");
  });
  it("masks a plus-tagged local part (tag stays hidden behind the hint)", () => {
    expect(maskEmail("asad+sales@gmail.com")).toBe("asa•••@gmail.com");
  });
  it("handles an address with an empty local part", () => {
    expect(maskEmail("@x.com")).toBe("•••@x.com");
  });
  it("returns empty for null", () => {
    expect(maskEmail(null)).toBe("");
  });
});

describe("maskCompany", () => {
  it("keeps the first word only", () => {
    expect(maskCompany("Acme AI")).toBe("Acme");
    expect(maskCompany("Forge")).toBe("Forge");
  });
  it("trims surrounding whitespace", () => {
    expect(maskCompany("  Acme AI  ")).toBe("Acme");
  });
  it("returns empty for null/empty", () => {
    expect(maskCompany(null)).toBe("");
    expect(maskCompany("")).toBe("");
  });
});

describe("maskPhone", () => {
  it("keeps the last 4 digits", () => {
    expect(maskPhone("+1 555 123 4567")).toBe("•••-4567");
    expect(maskPhone("(212) 867-5309")).toBe("•••-5309");
  });
  it("leaves a value with 4 or fewer digits untouched", () => {
    expect(maskPhone("123")).toBe("123");
    expect(maskPhone("4567")).toBe("4567");
  });
  it("returns empty for null", () => {
    expect(maskPhone(null)).toBe("");
  });
});

describe("maskFrom", () => {
  it("masks display name and email of a bracketed From header", () => {
    expect(maskFrom("John Smith <john@example.com>")).toBe("John S. <joh•••@example.com>");
  });
  it("masks a bare address with no display name", () => {
    expect(maskFrom("john@example.com")).toBe("joh•••@example.com");
  });
  it("handles a bracketed address with no display name", () => {
    expect(maskFrom("<john@example.com>")).toBe("<joh•••@example.com>");
  });
  it("masks a bare display name (no email) as a name, not an email", () => {
    expect(maskFrom("Asad Hussain")).toBe("Asad H.");
  });
});

describe("maskAuto", () => {
  it("masks as email when an @ is present, else as name", () => {
    expect(maskAuto("a@b.com")).toBe("a•••@b.com");
    expect(maskAuto("Asad Hussain")).toBe("Asad H.");
  });
  it("returns empty for null/empty", () => {
    expect(maskAuto(null)).toBe("");
    expect(maskAuto("")).toBe("");
  });
  it("leaves a non-PII fallback label untouched", () => {
    // Used by modal titles like `Send next step — (prospect)`.
    expect(maskAuto("(prospect)")).toBe("(prospect)");
  });
});

describe("applyMask — the privacy gate shared by <Pii> and useMask", () => {
  it("returns the RAW value when privacy is off", () => {
    expect(applyMask(false, "email", "asadhussain2408@gmail.com")).toBe(
      "asadhussain2408@gmail.com",
    );
    expect(applyMask(false, "name", "Asad Hussain")).toBe("Asad Hussain");
  });
  it("masks when privacy is on", () => {
    expect(applyMask(true, "email", "asadhussain2408@gmail.com")).toBe("asa•••@gmail.com");
    expect(applyMask(true, "name", "Asad Hussain")).toBe("Asad H.");
  });
  it("returns empty string for null/empty regardless of the flag", () => {
    expect(applyMask(true, "email", null)).toBe("");
    expect(applyMask(true, "email", undefined)).toBe("");
    expect(applyMask(true, "name", "")).toBe("");
    expect(applyMask(false, "email", null)).toBe("");
  });
});

describe("maskByKind", () => {
  it("dispatches to the right helper", () => {
    expect(maskByKind("name", "Asad Hussain")).toBe("Asad H.");
    expect(maskByKind("email", "asadhussain2408@gmail.com")).toBe("asa•••@gmail.com");
    expect(maskByKind("company", "Acme AI")).toBe("Acme");
    expect(maskByKind("phone", "+1 555 123 4567")).toBe("•••-4567");
    expect(maskByKind("from", "John Smith <john@example.com>")).toBe(
      "John S. <joh•••@example.com>",
    );
    expect(maskByKind("auto", "a@b.com")).toBe("a•••@b.com");
  });
});
