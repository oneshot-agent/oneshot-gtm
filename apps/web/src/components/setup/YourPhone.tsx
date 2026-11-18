import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CallsMeResponse, MemberPhoneView } from "@oneshot-gtm/shared-types";
import { Loader2, Phone } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import {
  phoneInputError,
  pollVerification,
  verifyFailure,
  yourPhoneScreen,
  type YourPhoneScreen,
} from "../../lib/memberPhone.ts";
import { useMask } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Input } from "../primitives/Field.tsx";

export const callsMeKey = ["calls-me"];

/**
 * The signed-in member's own phone: Call rings it first, and the prospect
 * sees it as the caller ID. Kept per member across the install, so it is
 * verified once for every workspace. It sits inside the Calls section's
 * form, so its buttons never submit it and Enter in the number verifies.
 */
export function YourPhone() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: callsMeKey, queryFn: api.callsMe, retry: false });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const setPhone = (phone: MemberPhoneView) => {
    qc.setQueryData<CallsMeResponse>(callsMeKey, (prev) => (prev ? { ...prev, phone } : prev));
    // The Calls page's Call button follows this member's phone.
    if (phone.status === "verified") void qc.invalidateQueries({ queryKey: ["calls"] });
  };
  const verify = useMutation({
    mutationFn: (phone: string) => api.verifyPhone(phone),
    onSuccess: (phone) => {
      setTimedOut(false);
      setEditing(false);
      setPhone(phone);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removePhone(),
    onSuccess: () => {
      setPhone({
        phone: null,
        status: "none",
        validationCode: null,
        verifiedAt: null,
        error: null,
      });
      void qc.invalidateQueries({ queryKey: ["calls"] });
    },
  });

  const screen = me.data ? yourPhoneScreen(me.data, { editing, timedOut }) : null;

  // While the phone rings, check until the code is typed or two minutes pass.
  useEffect(() => {
    if (screen !== "verifying") return;
    return pollVerification(api.checkPhone, {
      onPhone: setPhone,
      onTimeout: () => setTimedOut(true),
    });
    // setPhone only writes the cache; re-binding it would restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  if (!me.data || !screen)
    return (
      <YourPhoneFrame>
        {me.error ? (
          <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
            couldn't read your phone · {me.error.message}
          </div>
        ) : (
          <div className="text-[12px] text-ink-faint">…</div>
        )}
      </YourPhoneFrame>
    );

  const submit = () => {
    const error = phoneInputError(draft);
    setInputError(error);
    if (!error) verify.mutate(draft.trim());
  };
  return (
    <YourPhoneView
      screen={screen}
      phone={me.data.phone}
      failure={verifyFailure(me.data, { timedOut })}
      draft={draft}
      inputError={inputError ?? (verify.error ? verify.error.message : null)}
      busy={verify.isPending || remove.isPending}
      removeError={remove.error?.message ?? null}
      onDraft={(v) => {
        setDraft(v);
        setInputError(null);
        verify.reset();
      }}
      onVerify={submit}
      onRetry={() => {
        const again = me.data?.phone.phone;
        if (again) verify.mutate(again);
        else setEditing(true);
      }}
      onChange={() => {
        setDraft(me.data?.phone.phone ?? "");
        setEditing(true);
      }}
      onCancel={() => setEditing(false)}
      onRemove={() => remove.mutate()}
      canCancel={editing && me.data.phone.status === "verified"}
    />
  );
}

/** "Your phone", from its state alone, so each screen renders without a server. */
export function YourPhoneView({
  screen,
  phone,
  failure,
  draft,
  inputError,
  busy,
  removeError,
  canCancel,
  onDraft,
  onVerify,
  onRetry,
  onChange,
  onCancel,
  onRemove,
}: {
  screen: YourPhoneScreen;
  phone: MemberPhoneView;
  failure: string;
  draft: string;
  inputError: string | null;
  busy: boolean;
  removeError: string | null;
  canCancel: boolean;
  onDraft: (value: string) => void;
  onVerify: () => void;
  onRetry: () => void;
  onChange: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const mask = useMask();
  const spinner = busy && <Loader2 size={11} className="animate-spin" />;
  let body: React.ReactNode;
  if (screen === "no_keys") {
    body = (
      <p className="text-[12px] text-ink-faint">
        Ringing your phone from the dashboard needs the call keys. Until they're added, Call opens
        your phone app.
      </p>
    );
  } else if (screen === "enter") {
    body = (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="Your mobile, e.g. +1 512 555 0100"
            aria-label="Your mobile number"
            aria-invalid={inputError ? true : undefined}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              // The section's form would save on Enter; here it verifies.
              if (e.key === "Enter") {
                e.preventDefault();
                onVerify();
              }
            }}
          />
          <Button type="button" size="sm" disabled={busy} onClick={onVerify} {...readOnly}>
            {spinner} Verify
          </Button>
          {canCancel && (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        {inputError ? (
          <span className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
            {inputError}
          </span>
        ) : (
          <span className="text-[12px] text-ink-faint">
            We ring it once with a code to check it's yours.
          </span>
        )}
      </div>
    );
  } else if (screen === "verifying") {
    body = (
      <div className="flex flex-col gap-2" aria-live="polite">
        <div className="flex items-center gap-2 text-[13px] text-ink-cream">
          <Phone size={13} /> Your phone is ringing. Answer and type this code.
        </div>
        <div
          className="font-mono text-[32px] leading-none tracking-[0.3em] text-ink-cream"
          aria-label="Verification code"
        >
          {phone.validationCode ?? "······"}
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-faint">
          <Loader2 size={11} className="animate-spin" /> Waiting for the code on{" "}
          {mask("phone", phone.phone)}…
        </div>
      </div>
    );
  } else if (screen === "verified") {
    body = (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[13px] text-ink-cream">{mask("phone", phone.phone)}</span>
          <span className="text-[12px] text-[color:var(--ink-receipt-2)]">Verified</span>
          <Button type="button" size="sm" variant="ghost" onClick={onChange} {...readOnly}>
            Change
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRemove}
            {...readOnly}
          >
            {spinner} Remove
          </Button>
        </div>
        <span className="text-[12px] text-ink-faint">
          Call rings this phone first, and the person you call sees this number.
        </span>
        {removeError && (
          <span className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
            couldn't remove it · {removeError}
          </span>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {/* A retry the server refused says why now; the stored failure is older. */}
        <span className="text-[13px] text-[color:var(--ink-blocked-2)]">
          {inputError ?? failure}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={onRetry} {...readOnly}>
            {spinner} Try again
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onChange}>
            Use another number
          </Button>
        </div>
      </div>
    );
  }
  return (
    <YourPhoneFrame>
      {body}
      {screen !== "no_keys" && (
        <span className="text-[11.5px] text-ink-faint">Yours alone. Used in every workspace.</span>
      )}
    </YourPhoneFrame>
  );
}

function YourPhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="ln-eyebrow">Your phone</span>
      {children}
    </div>
  );
}
