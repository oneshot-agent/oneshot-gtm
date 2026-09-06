import type { PostalAddress } from "@oneshot-gtm/core";
import { Input } from "./primitives/Field.tsx";
export const blankMailAddress: PostalAddress = {
  name: "",
  address_line1: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  address_country: "US",
};
export function MailAddressForm({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: PostalAddress;
  onChange: (value: PostalAddress) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm text-ink-cream">{label}</legend>
      {(
        [
          ["name", "Name"],
          ["address_line1", "Street address"],
          ["address_line2", "Suite / unit"],
          ["address_city", "City"],
          ["address_state", "State"],
          ["address_zip", "ZIP"],
        ] as const
      ).map(([key, title]) => (
        <label className="block text-xs" key={key}>
          {title}
          <Input
            value={value[key] ?? ""}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </label>
      ))}
    </fieldset>
  );
}
