import type { PostalAddress } from "./direct-mail.ts";

/** Complete business mailing addresses only; a person's free-text location is not an address. */
export function extractBusinessAddress(value: unknown, name = ""): PostalAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  for (const key of ["businessAddress", "business_address", "companyAddress", "company_address"]) {
    if (p[key] && typeof p[key] === "object")
      return extractBusinessAddress(p[key], name || String(p.name ?? p.founderName ?? ""));
  }
  const read = (...keys: string[]) => {
    for (const key of keys) if (typeof p[key] === "string" && p[key].trim()) return p[key].trim();
    return "";
  };
  const country = read("address_country", "country").toUpperCase();
  if (country && !["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(country))
    return null;
  const address: PostalAddress = {
    name: name || read("name", "full_name", "founderName", "company"),
    address_line1: read(
      "address_line1",
      "street_address",
      "streetAddress",
      "address",
      "business_address",
    ),
    address_line2: read("address_line2", "suite"),
    address_city: read("address_city", "city"),
    address_state: read("address_state", "state", "region"),
    address_zip: read("address_zip", "zip", "postal_code", "postalCode"),
    address_country: "US",
  };
  return address.address_line1 &&
    address.address_city &&
    address.address_state &&
    address.address_zip
    ? address
    : null;
}

export function requireMailAddress(value: unknown): PostalAddress {
  const address = extractBusinessAddress(value);
  if (!address?.name)
    throw new Error("A complete U.S. mailing address and recipient name are required");
  if (
    Object.values(address).some(
      (v) => typeof v === "string" && (v.length > 200 || /[\r\n]/.test(v)),
    )
  )
    throw new Error("Address fields must be single lines of at most 200 characters");
  return address;
}

export function mailAddressKey(address: PostalAddress | null | undefined): string {
  if (!address) return "";
  return [
    address.name,
    address.address_line1,
    address.address_line2 ?? "",
    address.address_city,
    address.address_state,
    address.address_zip,
    address.address_country ?? "US",
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|");
}
