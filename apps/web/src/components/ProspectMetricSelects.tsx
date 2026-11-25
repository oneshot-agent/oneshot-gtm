import {
  ROLE_GROUPS,
  SIZE_BUCKETS,
  isRoleGroup,
  isSizeBucket,
  type RoleGroup,
  type SizeBucket,
} from "@oneshot-gtm/shared-types";
import { Select } from "./primitives/Field.tsx";

const SELECT_CLASS = "w-auto [&>select]:h-8 [&>select]:text-[12px]";

/**
 * The Role and Size filters the Queue and Calls views share. "All" clears
 * the field (undefined), so the URL drops it.
 */
export function ProspectMetricSelects(props: {
  role: RoleGroup | null;
  size: SizeBucket | null;
  onChange: (patch: { role?: RoleGroup | undefined; size?: SizeBucket | undefined }) => void;
}) {
  return (
    <>
      <Select
        aria-label="Filter by role"
        className={SELECT_CLASS}
        value={props.role ?? "all"}
        onChange={(e) =>
          props.onChange({ role: isRoleGroup(e.target.value) ? e.target.value : undefined })
        }
      >
        <option value="all">All roles</option>
        {ROLE_GROUPS.map((g) => (
          <option key={g.key} value={g.key}>
            {g.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Filter by company size"
        className={SELECT_CLASS}
        value={props.size ?? "all"}
        onChange={(e) =>
          props.onChange({ size: isSizeBucket(e.target.value) ? e.target.value : undefined })
        }
      >
        <option value="all">All sizes</option>
        <optgroup label="Staff">
          {SIZE_BUCKETS.filter((b) => b.kind === "staff").map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Locations">
          {SIZE_BUCKETS.filter((b) => b.kind === "sites").map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </optgroup>
        <option value="unknown">Size unknown</option>
      </Select>
    </>
  );
}
