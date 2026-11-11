import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DomainPoolView, DomainQuoteView } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Select } from "../primitives/Field.tsx";

export function DomainSetupForm({ domains }: { domains: DomainPoolView[] }) {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [mode, setMode] = useState<"relay" | "mailbox">("relay");
  const [addresses, setAddresses] = useState("agent");
  const [quote, setQuote] = useState<DomainQuoteView | null>(null);
  const [purchased, setPurchased] = useState(false);
  const owned = domains.find((d) => d.domain === domain.trim().toLowerCase());
  const quoteCall = useMutation({
    mutationFn: () =>
      api.quoteDomain({
        domain,
        mailboxMode: owned?.mailboxMode ?? mode,
        addresses: addresses.split(",").map((a) => a.trim()),
      }),
    onSuccess: (result) => {
      setQuote(result);
      setPurchased(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const buyCall = useMutation({
    mutationFn: () => {
      if (!quote?.quote_id || (quote.expires_at && Date.parse(quote.expires_at) <= Date.now()))
        throw new Error("Quote expired. Request a new quote and review its price.");
      return api.buyDomain({ domain: quote.domain, quoteId: quote.quote_id });
    },
    onSuccess: (result) => {
      setQuote(null);
      setPurchased(true);
      toast.success(result.message ?? "Setup requested. No email was sent.");
      void queryClient.invalidateQueries({ queryKey: ["setup"] });
    },
    onError: (e: Error) => {
      setQuote(null);
      toast.error(e.message);
    },
  });
  const refresh = useMutation({
    mutationFn: api.refreshSetupDomains,
    onSuccess: (result) => queryClient.setQueryData(["setup", "domains"], result),
    onError: (e: Error) => toast.error(e.message),
  });
  const busy = quoteCall.isPending || buyCall.isPending;
  const change = () => {
    setQuote(null);
    setPurchased(false);
  };
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-ink-rule pt-3">
      <span className="ln-eyebrow">Set up a domain or add addresses</span>
      <p className="text-[12px] text-ink-muted">
        Buy a sending domain or add addresses to one you own. Setup is separate from email and from
        saving this page.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Domain">
          <Input
            aria-label="setup domain"
            list="oneshot-domains"
            value={domain}
            disabled={busy}
            onChange={(e) => {
              change();
              setDomain(e.target.value);
            }}
            placeholder="example.com"
          />
        </Field>
        <Field label="Mode">
          <Select
            aria-label="domain mode"
            disabled={busy || !!owned}
            value={owned?.mailboxMode ?? mode}
            onChange={(e) => {
              change();
              setMode(e.target.value as "relay" | "mailbox");
            }}
          >
            <option value="relay">Relay</option>
            <option value="mailbox">Hosted mailbox</option>
          </Select>
        </Field>
        <Field label="Addresses (1–10, comma separated)">
          <Input
            aria-label="setup addresses"
            value={addresses}
            disabled={busy}
            onChange={(e) => {
              change();
              setAddresses(e.target.value);
            }}
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !domain.trim()}
          onClick={() => {
            setQuote(null);
            quoteCall.mutate();
          }}
          {...readOnly}
        >
          {quoteCall.isPending ? "Getting quote…" : "Review price"}
        </Button>
      </div>
      <p className="text-[12px] text-ink-faint">
        Relay addresses have no hosted inbox and are not warmed. Mailbox addresses have a hosted
        inbox and warm individually. Existing domains keep their mode.
      </p>
      {quote && (
        <div
          className="flex flex-col gap-2 border border-ink-rule rounded-[var(--radius-sm)] p-3"
          role="status"
        >
          <p>
            {quote.setup === "domain_addresses" ? "Add addresses to" : "Set up"} {quote.domain}
          </p>
          <p className="text-[13px]">
            {quote.addresses?.join(", ")} · {quote.mailbox_mode} · {quote.currency ?? "USD"}{" "}
            {quote.total_cost ?? "unavailable"}
          </p>
          {quote.already_set_up?.length ? (
            <p className="text-[12px]">Already set up: {quote.already_set_up.join(", ")}</p>
          ) : null}
          <p className="text-[12px]">{quote.billing?.summary ?? ""}</p>
          {quote.billing && (
            <p className="text-[12px]">
              {quote.billing.one_time ? "One-time charge" : "Recurring charge"} · Term:{" "}
              {quote.billing.term_years} year(s) · Renewal charged:{" "}
              {quote.billing.renewal_charged ? "yes" : "no"}
            </p>
          )}
          {quote.expires_at && (
            <p className="text-[12px]">
              Quote expires {new Date(quote.expires_at).toLocaleString()}
            </p>
          )}
          {!quote.purchasable && <p>{quote.reason ?? "This setup cannot be purchased."}</p>}
          <Button
            type="button"
            disabled={busy || !quote.purchasable || !quote.quote_id || quote.total_cost == null}
            onClick={() => buyCall.mutate()}
            {...readOnly}
          >
            {buyCall.isPending
              ? "Purchasing…"
              : `Confirm purchase · ${quote.currency ?? "USD"} ${quote.total_cost ?? ""}`}
          </Button>
        </div>
      )}
      {purchased && (
        <p className="text-[12px]" role="status">
          Setup requested. Addresses may still be provisioning. Refresh status below; add a sender
          once its address is active.
        </p>
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
      >
        Refresh domain status
      </Button>
    </div>
  );
}
