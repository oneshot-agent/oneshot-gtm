import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectMailDraft, PostalAddress } from "@oneshot-gtm/core";
import { Button } from "./primitives/Button.tsx";
import { Input, Select } from "./primitives/Field.tsx";
import { readOnly } from "../lib/readOnly.ts";
const blank: PostalAddress = {
  name: "",
  address_line1: "",
  address_city: "",
  address_state: "",
  address_zip: "",
};
async function action(name: string, body: unknown) {
  const response = await fetch(`/api/direct-mail/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function AddressForm({
  label,
  value,
  set,
}: {
  label: string;
  value: PostalAddress;
  set: (v: PostalAddress) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend>{label}</legend>
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
        <label className="block text-sm" key={key}>
          {title}
          <Input
            value={value[key] ?? ""}
            onChange={(e) => set({ ...value, [key]: e.target.value })}
          />
        </label>
      ))}
    </fieldset>
  );
}
export function DirectMailPanel() {
  const cache = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState<PostalAddress>({ ...blank });
  const [from, setFrom] = useState<PostalAddress>({ ...blank });
  const [prospect, setProspect] = useState("");
  const [play, setPlay] = useState("");
  const [kind, setKind] = useState("letter");
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const { data } = useQuery<{ drafts: DirectMailDraft[]; returnAddress: PostalAddress | null }>({
    queryKey: ["direct-mail"],
    queryFn: async () => {
      const r = await fetch("/api/direct-mail");
      if (!r.ok) throw new Error("Could not load direct mail");
      return r.json();
    },
  });
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await cache.invalidateQueries({ queryKey: ["direct-mail"] });
      await cache.invalidateQueries({ queryKey: ["cadences"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | null) {
    if (!file) throw new Error("Select artwork for each side");
    const r = await fetch("/api/direct-mail/upload", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error);
    return v.asset_id as string;
  }
  return (
    <details className="border-b border-ink-rule p-6">
      <summary className="cursor-pointer text-ink-cream">
        Direct mail · letters and 4×6 postcards
      </summary>
      <p className="my-3 text-sm">
        Review each recipient, print proof, and price before approving. Delivery does not prove
        readership.
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const first = await upload(front);
            const artwork =
              kind === "letter"
                ? { kind: "letter", file: first }
                : { kind: "postcard", front: first, back: await upload(back) };
            await action("preview", {
              prospectId: Number(prospect),
              playName: play,
              input: { to, from, artwork },
            });
          });
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label>
            Prospect ID
            <Input required value={prospect} onChange={(e) => setProspect(e.target.value)} />
          </label>
          <label>
            Cadence play
            <Input required value={play} onChange={(e) => setPlay(e.target.value)} />
          </label>
        </div>
        <p className="text-sm">This mailpiece replaces the prospect’s next cadence step.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <AddressForm label="Recipient · U.S." value={to} set={setTo} />
          <AddressForm label="Return address · U.S." value={from} set={setFrom} />
        </div>
        {data?.returnAddress && (
          <Button type="button" variant="secondary" onClick={() => setFrom(data.returnAddress!)}>
            Use workspace return address
          </Button>
        )}
        <label className="block">
          Format
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="letter">Letter · black and white, single-sided</option>
            <option value="postcard">4×6 postcard</option>
          </Select>
        </label>
        <label className="block">
          {kind === "letter" ? "Print-ready PDF" : "Front artwork"}
          <input
            type="file"
            required
            accept={kind === "letter" ? ".pdf" : ".pdf,.png,.jpg,.jpeg"}
            onChange={(e) => setFront(e.target.files?.[0] ?? null)}
          />
        </label>
        {kind === "postcard" && (
          <label className="block">
            Back artwork
            <input
              type="file"
              required
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(e) => setBack(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
        <Button disabled={busy || readOnly.disabled} type="submit">
          Validate and preview price
        </Button>
      </form>
      <div className="mt-6 space-y-5">
        {data?.drafts.map((d) => (
          <article key={d.id} className="border-t border-ink-rule pt-4">
            <p>
              {d.playName} · prospect {d.prospectId} · step {d.stepIndex}
            </p>
            <p>
              {d.input.to.name}, {d.input.to.address_line1}, {d.input.to.address_line2}{" "}
              {d.input.to.address_city}, {d.input.to.address_state} {d.input.to.address_zip}
            </p>
            <p>
              Return: {d.input.from.name}, {d.input.from.address_line1}, {d.input.from.address_city}
              , {d.input.from.address_state} {d.input.from.address_zip}
            </p>
            <p>
              {d.input.artwork.kind === "letter" ? "Letter" : "4×6 postcard"} ·{" "}
              {d.quote.total_usdc ? `${d.quote.total_usdc} USDC` : "Rendering proof and price"} ·{" "}
              {d.order?.order_status ??
                (d.canceled
                  ? "Canceled"
                  : d.cancelRequested
                    ? "Cancellation requested"
                    : d.approvalId
                      ? "Approved"
                      : "Awaiting approval")}
            </p>
            {d.quote.preview.url && (
              <a href={d.quote.preview.url} target="_blank" rel="noreferrer" className="underline">
                Open print proof
              </a>
            )}
            {d.order && (
              <p>
                Payment: {d.order.payment_status} · Fulfillment: {d.order.fulfillment_status}
                {d.order.refunded_at ? " · Full credit issued" : ""}
                {d.order.cancellation_error ? ` · ${d.order.cancellation_error}` : ""}
              </p>
            )}
            <div className="my-2 flex flex-wrap gap-2">
              <Button
                disabled={busy}
                variant="secondary"
                onClick={() => void run(() => action("refresh", { id: d.id }))}
              >
                Refresh
              </Button>
              {!d.started && !d.canceled && !d.approvalId && (
                <Button
                  disabled={
                    busy ||
                    readOnly.disabled ||
                    d.quote.status !== "ready" ||
                    Date.parse(d.quote.expires_at) < Date.now()
                  }
                  onClick={() =>
                    void run(() =>
                      action("approve", {
                        id: d.id,
                        approval: {
                          input_hash: d.quote.input_hash,
                          total_usdc: d.quote.total_usdc,
                          approved: true,
                        },
                      }),
                    )
                  }
                >
                  {d.quote.total_usdc
                    ? `Approve this proof and ${d.quote.total_usdc} USDC`
                    : "Awaiting proof and price"}
                </Button>
              )}
              {d.approvalId && (
                <Button
                  disabled={busy || readOnly.disabled || d.canceled || d.cancelRequested}
                  onClick={() => void run(() => action("send", { id: d.id }))}
                >
                  {d.started ? "Recover cadence step" : "Send approved mailpiece"}
                </Button>
              )}
              <Button
                disabled={busy || readOnly.disabled}
                variant="danger"
                onClick={() => void run(() => action("cancel", { id: d.id }))}
              >
                Cancel
              </Button>
            </div>
            {d.order?.events.map((e) => (
              <p key={e.event_id} className="text-sm">
                {e.occurred_at} · {e.event_type}
              </p>
            ))}
          </article>
        ))}
      </div>
    </details>
  );
}
