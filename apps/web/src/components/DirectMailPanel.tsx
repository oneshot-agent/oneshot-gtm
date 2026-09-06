import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectMailDraft, MailPreparation, PostalAddress } from "@oneshot-gtm/core";
import type { CadenceView } from "@oneshot-gtm/shared-types";
import { Button } from "./primitives/Button.tsx";
import { Textarea } from "./primitives/Field.tsx";
import { Modal } from "./primitives/Modal.tsx";
import { MailAddressForm, blankMailAddress } from "./MailAddressForm.tsx";
import { readOnly } from "../lib/readOnly.ts";

export async function mailAction(name: string, body: unknown) {
  const response = await fetch(`/api/direct-mail/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Mail action failed");
  return result;
}
interface MailContext {
  configuredMail?: boolean;
  drafts: DirectMailDraft[];
  draft?: DirectMailDraft | null;
  preparation?: MailPreparation | null;
  address?: PostalAddress | null;
  returnAddress: PostalAddress | null;
  founderName: string | null;
  addressSource?: { source?: string } | null;
}
function sameAddress(a: PostalAddress | null | undefined, b: PostalAddress): boolean {
  if (!a) return false;
  return (
    [
      "name",
      "address_line1",
      "address_line2",
      "address_city",
      "address_state",
      "address_zip",
      "address_country",
    ] as const
  ).every(
    (key) =>
      (a[key] ?? (key === "address_country" ? "US" : "")).trim().toLowerCase() ===
      (b[key] ?? (key === "address_country" ? "US" : "")).trim().toLowerCase(),
  );
}
function AddressSummary({ address }: { address: PostalAddress }) {
  return (
    <p className="text-sm">
      {address.name}
      <br />
      {address.address_line1}
      {address.address_line2 && <>, {address.address_line2}</>}
      <br />
      {address.address_city}, {address.address_state} {address.address_zip}
    </p>
  );
}
export function DirectMailPanel({
  prospect,
  onClose,
}: {
  prospect: CadenceView;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const identity = { prospectId: prospect.prospectId, playName: prospect.playName };
  const queryKey = ["direct-mail", prospect.prospectId, prospect.playName];
  const { data, error: loadError } = useQuery<MailContext>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(
        `/api/direct-mail?prospectId=${prospect.prospectId}&playName=${encodeURIComponent(prospect.playName)}`,
      );
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      return result;
    },
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [to, setTo] = useState<PostalAddress>({
    ...blankMailAddress,
    name: prospect.prospectName ?? "",
  });
  const [from, setFrom] = useState<PostalAddress>({ ...blankMailAddress });
  const [editingTo, setEditingTo] = useState(false),
    [editingFrom, setEditingFrom] = useState(false);
  const [body, setBody] = useState(""),
    [mode, setMode] = useState<"generated" | "upload">("generated");
  useEffect(() => {
    if (!data) return;
    if (!editingTo)
      setTo(data.address ?? { ...blankMailAddress, name: prospect.prospectName ?? "" });
    if (!editingFrom)
      setFrom(data.returnAddress ?? { ...blankMailAddress, name: data.founderName ?? "" });
  }, [data, editingTo, editingFrom, prospect.prospectName]);
  const savedBody = data?.preparation?.body,
    savedMode = data?.preparation?.mode;
  useEffect(() => {
    if (savedMode) {
      setBody(savedBody ?? "");
      setMode(savedMode);
    }
  }, [savedBody, savedMode]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["direct-mail"] }),
        cache.invalidateQueries({ queryKey: ["cadences"] }),
      ]);
      setBusy(false);
    }
  }
  const draft =
    data?.draft ??
    data?.drafts.find(
      (d) => d.enrollment === prospect.enrolledAt && d.stepIndex === prospect.currentStep + 1,
    );
  const renderingDraftId =
    draft?.quote.status === "rendering" && !draft.started ? draft.id : undefined;
  useEffect(() => {
    if (!renderingDraftId || busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        await mailAction("refresh", { id: renderingDraftId });
        if (!disposed) await cache.invalidateQueries({ queryKey: ["direct-mail"] });
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 3000);
      }
    }
    timer = setTimeout(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [renderingDraftId, busy, cache]);
  const proofAddressesCurrent =
    draft?.started ||
    !draft?.addressInputs ||
    (sameAddress(data?.address, draft.addressInputs.to) &&
      sameAddress(data?.returnAddress, draft.addressInputs.from));
  const changed = data?.preparation
    ? mode !== data.preparation.mode ||
      (mode === "generated" && body !== (data.preparation.body ?? ""))
    : !!body.trim() || mode === "upload";
  const editable = !draft?.started && !prospect.isSending && data?.configuredMail !== false;
  const disabled = busy || readOnly.disabled;
  return (
    <Modal
      open
      title={`Mail · ${prospect.prospectName ?? prospect.prospectEmail ?? "Prospect"}`}
      subtitle={prospect.playName}
      onClose={onClose}
      width={820}
    >
      <div className="space-y-5">
        {(error || loadError) && (
          <p role="alert" className="text-sm text-red-400">
            {error || loadError?.message}
          </p>
        )}
        {!data ? (
          <p>Loading mail step…</p>
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                {!data.address || editingTo ? (
                  <>
                    <MailAddressForm
                      label="Business address · U.S."
                      value={to}
                      onChange={(value) => {
                        setTo(value);
                        setEditingTo(true);
                      }}
                      disabled={!editable || disabled}
                    />
                    <Button
                      size="sm"
                      disabled={disabled || !editable}
                      onClick={() =>
                        void run(async () => {
                          await mailAction("address", { ...identity, address: to });
                          setEditingTo(false);
                        })
                      }
                    >
                      Save business address
                    </Button>
                    {!data.address && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          void run(async () => {
                            const r = await mailAction("research-address", identity);
                            if (!r.address)
                              throw new Error(
                                "No complete business address found. Add the address to continue.",
                              );
                          })
                        }
                      >
                        Find business address
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-ink-muted">TO · BUSINESS ADDRESS</p>
                    <AddressSummary address={data.address} />
                    {editable && (
                      <Button size="sm" variant="ghost" onClick={() => setEditingTo(true)}>
                        Edit
                      </Button>
                    )}
                  </>
                )}
                {data.addressSource?.source?.startsWith("https://") && (
                  <a
                    href={data.addressSource.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline"
                  >
                    Address source
                  </a>
                )}
              </div>
              <div>
                {!data.returnAddress || editingFrom ? (
                  <>
                    <MailAddressForm
                      label="Founder return address · U.S."
                      value={from}
                      onChange={(value) => {
                        setFrom(value);
                        setEditingFrom(true);
                      }}
                      disabled={disabled || !editable}
                    />
                    <Button
                      size="sm"
                      disabled={disabled || !editable}
                      onClick={() =>
                        void run(async () => {
                          await mailAction("return-address", { address: from });
                          setEditingFrom(false);
                        })
                      }
                    >
                      Save return address
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-ink-muted">FROM · RETURN ADDRESS</p>
                    <AddressSummary address={data.returnAddress} />
                    {editable && (
                      <Button size="sm" variant="ghost" onClick={() => setEditingFrom(true)}>
                        Edit workspace return address
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
            {editable && (
              <div className="space-y-3 border-t border-ink-rule pt-4">
                <div className="flex gap-4 text-sm">
                  <label>
                    <input
                      type="radio"
                      name="mail-content"
                      checked={mode === "generated"}
                      onChange={() => setMode("generated")}
                      disabled={disabled}
                    />{" "}
                    Personalized letter
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mail-content"
                      checked={mode === "upload"}
                      onChange={() => setMode("upload")}
                      disabled={disabled}
                    />{" "}
                    Upload PDF/JPEG
                  </label>
                </div>
                {mode === "generated" ? (
                  <>
                    <Textarea
                      aria-label="Letter content"
                      rows={10}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Generate a personalized letter, or write your own."
                      disabled={disabled}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() =>
                        void run(async () => {
                          const r = await mailAction("generate", identity);
                          setBody(r.preparation.body);
                        })
                      }
                    >
                      {body ? "Regenerate letter" : "Generate personalized letter"}
                    </Button>
                  </>
                ) : (
                  <label className="block text-sm">
                    Artwork for this prospect · PDF or JPEG, up to 20 MB
                    <input
                      className="mt-2 block"
                      type="file"
                      accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg"
                      disabled={disabled}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void run(async () => {
                          if (file.size > 20 * 1024 * 1024)
                            throw new Error("Artwork exceeds 20 MB");
                          const params = new URLSearchParams({
                            prospectId: String(prospect.prospectId),
                            playName: prospect.playName,
                            filename: file.name,
                          });
                          const r = await fetch(`/api/direct-mail/upload?${params}`, {
                            method: "POST",
                            headers: {
                              "Content-Type":
                                file.type ||
                                (/\.pdf$/i.test(file.name) ? "application/pdf" : "image/jpeg"),
                            },
                            body: file,
                          });
                          const result = await r.json();
                          if (!r.ok) throw new Error(result.error);
                          setMode("upload");
                        });
                      }}
                    />
                    {data.preparation?.mode === "upload" && (
                      <p className="mt-2">Selected: {data.preparation.filename}</p>
                    )}
                  </label>
                )}
                <Button
                  disabled={
                    disabled ||
                    !data.address ||
                    !data.returnAddress ||
                    editingTo ||
                    editingFrom ||
                    (mode === "upload" && data.preparation?.mode !== "upload")
                  }
                  onClick={() =>
                    void run(async () => {
                      if (mode === "generated" && body.trim())
                        await mailAction("save-letter", { ...identity, body });
                      else if (mode === "generated" && data.preparation?.mode === "generated")
                        throw new Error("Enter letter text or generate a new letter first");
                      else if (mode === "generated" && data.preparation?.mode === "upload")
                        await mailAction("generate", identity);
                      await mailAction("preview", identity);
                    })
                  }
                >
                  {busy ? "Preparing…" : "Preview print proof and price"}
                </Button>
                {(!data.address || !data.returnAddress) && (
                  <p className="text-xs">
                    Add the missing address to prepare this mailpiece. The cadence waits here.
                  </p>
                )}
              </div>
            )}
            {draft && !proofAddressesCurrent && (
              <p className="text-sm">Addresses changed. Prepare a new print proof and price.</p>
            )}
            {draft && (
              <Mailpiece
                draft={draft}
                disabled={
                  disabled ||
                  (!draft.started &&
                    (changed || editingTo || editingFrom || !proofAddressesCurrent))
                }
                run={run}
              />
            )}
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    await mailAction("skip", identity);
                    onClose();
                  })
                }
              >
                Skip mail and continue cadence
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
function Mailpiece({
  draft: d,
  disabled,
  run,
  history = false,
}: {
  history?: boolean;
  draft: DirectMailDraft;
  disabled: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const ready =
    d.quote.status === "ready" &&
    !!d.quote.preview.url &&
    !!d.quote.total_usdc &&
    Date.parse(d.quote.expires_at) > Date.now();
  return (
    <article className="space-y-3 border-t border-ink-rule pt-4 text-sm">
      <p>
        {d.order?.order_status ??
          (d.canceled
            ? "Canceled"
            : d.cancelRequested
              ? "Cancellation requested"
              : "Awaiting review")}{" "}
        · {d.quote.total_usdc ? `${d.quote.total_usdc} USDC` : "Rendering proof and price"}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <span className="text-xs">Proof recipient</span>
          <AddressSummary address={d.input.to} />
        </div>
        <div>
          <span className="text-xs">Proof return address</span>
          <AddressSummary address={d.input.from} />
        </div>
      </div>
      {d.quote.preview.url && (
        <a
          className="inline-block underline"
          href={d.quote.preview.url}
          target="_blank"
          rel="noreferrer"
        >
          Open print proof
        </a>
      )}
      {d.order && (
        <p>
          Payment: {d.order.payment_status} · Fulfillment: {d.order.fulfillment_status}
          {d.order.refunded_at ? " · Refunded" : ""}
          {d.order.cancellation_error && ` · ${d.order.cancellation_error}`}
        </p>
      )}
      {!d.started && Date.parse(d.quote.expires_at) <= Date.now() && (
        <p>Proof expired. Prepare a new proof and price.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void run(() => mailAction("refresh", { id: d.id }))}
        >
          Refresh status
        </Button>
        {!history && !d.started && !d.canceled && !d.cancelRequested && (
          <Button
            size="sm"
            disabled={disabled || readOnly.disabled || !ready}
            onClick={() =>
              void run(() =>
                mailAction("approve-send", {
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
            Approve and send · {d.quote.total_usdc ?? "…"} USDC
          </Button>
        )}
        {d.started && !d.cancelRequested && !d.canceled && (
          <Button
            size="sm"
            disabled={disabled || readOnly.disabled}
            onClick={() => void run(() => mailAction("send", { id: d.id }))}
          >
            Recover cadence step
          </Button>
        )}
        {!d.canceled && !d.cancelRequested && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || readOnly.disabled}
            onClick={() => void run(() => mailAction("cancel", { id: d.id }))}
          >
            Cancel mailpiece
          </Button>
        )}
      </div>
      {d.order?.events.map((e) => (
        <p className="text-xs" key={e.event_id}>
          {e.occurred_at} · {e.event_type}
        </p>
      ))}
    </article>
  );
}
export function DirectMailHistory() {
  const cache = useQueryClient();
  const { data } = useQuery<MailContext>({
    queryKey: ["direct-mail", "history"],
    queryFn: async () => {
      const r = await fetch("/api/direct-mail");
      if (!r.ok) throw new Error("Could not load mail history");
      return r.json();
    },
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (!data?.drafts.length) return null;
  return (
    <details className="border-b border-ink-rule p-6">
      <summary className="cursor-pointer text-sm">Mail history · {data.drafts.length}</summary>
      {error && <p role="alert">{error}</p>}
      {data.drafts.map((d) => (
        <div key={d.id}>
          <p className="mt-4 text-sm">
            {d.input.to.name} · {d.playName}
          </p>
          <Mailpiece
            draft={d}
            history
            disabled={busy}
            run={async (work) => {
              setBusy(true);
              setError("");
              try {
                await work();
                await cache.invalidateQueries({ queryKey: ["direct-mail"] });
                await cache.invalidateQueries({ queryKey: ["cadences"] });
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      ))}
    </details>
  );
}
