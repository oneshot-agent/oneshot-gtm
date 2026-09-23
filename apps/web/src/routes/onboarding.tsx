import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  normalizeWebsite,
  type LlmProvider,
  type OnboardingStatus,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";
import { LLM_DEFAULTS, LLM_KEY } from "../components/setup/constants.ts";
import { openStrategist } from "../lib/openStrategist.ts";

export const Route = createFileRoute("/onboarding")({
  staticData: { title: "Get ready to plan" },
  component: OnboardingPage,
});
function OnboardingPage() {
  const status = useQuery({ queryKey: ["onboarding"], queryFn: api.onboarding, enabled: !IS_DEMO });
  if (IS_DEMO || status.data?.demo)
    return (
      <p>
        The demo is ready to explore. <Link to="/">Back to Today</Link>
      </p>
    );
  if (status.error && !status.data)
    return (
      <p role="alert">
        Could not load onboarding. <button onClick={() => void status.refetch()}>Try again</button>
      </p>
    );
  if (!status.data) return <p role="status">Loading your saved progress…</p>;
  return <OnboardingForm initial={status.data} />;
}
function OnboardingForm({ initial }: { initial: OnboardingStatus }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(initial);
  const [step, setStep] = useState<number>(initial.ready ? 4 : initial.nextStep);
  const [values, setValues] = useState(initial.context);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [key, setKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useBlocker({
    shouldBlockFn: () =>
      dirtyRef.current &&
      !window.confirm("Leave without saving your changes? Completed steps are saved."),
    enableBeforeUnload: () => dirtyRef.current,
  });
  function change(field: keyof typeof values, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    setDirty(true);
  }
  function accept(status: OnboardingStatus) {
    setSaved(status);
    qc.setQueryData(["onboarding"], status);
    void qc.invalidateQueries({ queryKey: ["setup"] });
  }
  async function submit() {
    const problems: Record<string, string> = {};
    if (step === 1) {
      if (!values.founderName.trim()) problems.founderName = "Enter your name.";
      if (!normalizeWebsite(values.productDomain))
        problems.productDomain = "Enter a website domain or HTTP(S) URL.";
      if (!values.productOneLiner.trim()) problems.productOneLiner = "Describe what you sell.";
    }
    if (step === 2 && !values.icpOneLiner.trim())
      problems.icpOneLiner = "Describe who you want to reach.";
    if (step === 3) {
      if (!model.trim()) problems.model = "Enter a model ID or restore the default.";
      if (!key.trim() && !saved.credentials[provider]) problems.key = "Enter your API key.";
    }
    setErrors(problems);
    setError("");
    if (Object.keys(problems).length) {
      setError("Complete the required fields below.");
      return;
    }
    setBusy(true);
    try {
      if (step === 1)
        await api.setup({
          onboardingStep: 1,
          founderName: values.founderName.trim(),
          productDomain: normalizeWebsite(values.productDomain)!,
          productOneLiner: values.productOneLiner.trim(),
        });
      if (step === 2)
        await api.setup({ onboardingStep: 2, icpOneLiner: values.icpOneLiner.trim() });
      if (step === 3)
        await api.setup({
          onboardingStep: 3,
          llmProvider: provider,
          llmModel: model.trim(),
          ...(key.trim() ? { secrets: { [LLM_KEY[provider]]: key.trim() } } : {}),
        });
      setDirty(false);
      dirtyRef.current = false;
      setKey("");
      const status = await api.onboarding();
      accept(status);
      setValues(status.context);
      if (step === 3) {
        const verified = await api.verifyOnboardingAI();
        accept(verified);
        setStep(verified.ready ? 4 : verified.nextStep);
      } else setStep(step + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finishLater() {
    if (dirty && !window.confirm("Leave without saving this step? Completed steps are saved."))
      return;
    setBusy(true);
    setError("");
    try {
      accept(await api.deferOnboarding());
      dirtyRef.current = false;
      setDirty(false);
      await navigate({ to: "/" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const titles = ["Your business", "Your customer", "Connect AI"];
  return (
    <div className="mx-auto w-full max-w-xl space-y-8 py-6 [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-ink-signal">
      <nav aria-label="Onboarding progress">
        <ol className="grid grid-cols-3 gap-3 text-sm">
          {titles.map((title, i) => (
            <li
              key={title}
              aria-current={step === i + 1 ? "step" : undefined}
              className={`border-t-2 pt-3 ${step >= i + 1 ? "border-ink-cream text-ink-cream" : "border-ink-rule text-ink-muted"}`}
            >
              {i + 1}. {title}
            </li>
          ))}
        </ol>
      </nav>
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-3xl font-semibold text-ink-cream outline-none"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {step === 4 ? "Ready to plan" : titles[step - 1]}
      </h1>
      {error && (
        <p role="alert" className="text-ink-blocked-2">
          {error}
        </p>
      )}
      {step === 4 ? (
        <div className="space-y-5">
          <p>Your business context is saved and your AI connection is verified.</p>
          <dl className="space-y-3 text-sm">
            {Object.entries({
              Founder: saved.context.founderName,
              Website: saved.context.productDomain,
              Product: saved.context.productOneLiner,
              Customer: saved.context.icpOneLiner,
              AI: `${saved.provider} · ${saved.model}`,
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-ink-muted">{label}</dt>
                <dd className="break-words text-ink-cream">{value}</dd>
              </div>
            ))}
          </dl>
          <Button onClick={openStrategist}>Plan my first motion</Button>
          <div>
            <Link to="/">Go to Today</Link>
          </div>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-6"
        >
          <fieldset disabled={busy} className="space-y-5">
            {step === 1 && (
              <>
                <Field label="Founder name" error={errors.founderName}>
                  <Input
                    autoComplete="name"
                    value={values.founderName}
                    onChange={(e) => change("founderName", e.target.value)}
                    required
                  />
                </Field>
                <Field
                  label="Website"
                  hint={
                    saved.context.productDomain
                      ? `Saved domain: ${saved.context.productDomain}`
                      : "A domain or HTTP(S) URL. We will not scrape your website."
                  }
                  error={errors.productDomain}
                >
                  <Input
                    placeholder="example.com"
                    value={values.productDomain}
                    onChange={(e) => change("productDomain", e.target.value)}
                    required
                  />
                </Field>
                <Field
                  label="What you sell"
                  hint="One sentence describing your product or service and its benefit."
                  error={errors.productOneLiner}
                >
                  <Textarea
                    value={values.productOneLiner}
                    onChange={(e) => change("productOneLiner", e.target.value)}
                    required
                  />
                </Field>
              </>
            )}
            {step === 2 && (
              <Field
                label="Who you want to reach"
                hint="Describe the buyer role, business type, and problem you solve. Include geography when relevant. This becomes your ideal customer profile (ICP)."
                error={errors.icpOneLiner}
              >
                <Textarea
                  value={values.icpOneLiner}
                  onChange={(e) => change("icpOneLiner", e.target.value)}
                  required
                />
              </Field>
            )}
            {step === 3 && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="AI provider">
                    <Select
                      value={provider}
                      onChange={(e) => {
                        const next = e.target.value as LlmProvider;
                        setProvider(next);
                        setModel(LLM_DEFAULTS[next]!);
                        setKey("");
                        setDirty(true);
                      }}
                    >
                      <option value="openrouter">OpenRouter</option>
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                    </Select>
                  </Field>
                  <Field
                    label="API key"
                    error={errors.key}
                    hint={
                      saved.credentials[provider]
                        ? "Existing credentials found, including environment keys. Leave blank to keep them."
                        : "Use a key from your selected provider."
                    }
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={key}
                      onChange={(e) => {
                        setKey(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </Field>
                </div>
                <p className="text-sm text-ink-muted">Model: {model}</p>
                <details>
                  <summary className="cursor-pointer">Advanced: custom model</summary>
                  <div className="mt-3">
                    <Field label="Model ID" error={errors.model}>
                      <Input
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          setDirty(true);
                        }}
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setModel(LLM_DEFAULTS[provider]!);
                        setDirty(true);
                      }}
                    >
                      Restore default model
                    </Button>
                  </div>
                </details>
                <p className="text-sm text-ink-muted">
                  Testing sends one small request to your AI provider and may incur provider
                  charges.
                </p>
              </>
            )}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            {step > 1 && (
              <Button
                type="button"
                disabled={busy}
                variant="secondary"
                onClick={() => {
                  if (dirty && !window.confirm("Discard unsaved changes to this step?")) return;
                  setValues(saved.context);
                  setProvider(saved.provider);
                  setModel(saved.model);
                  setKey("");
                  setDirty(false);
                  setErrors({});
                  setError("");
                  setStep(step - 1);
                }}
              >
                Back
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : step === 3 ? "Save and test connection" : "Save and continue"}
            </Button>
            <Button
              type="button"
              disabled={busy}
              variant="ghost"
              onClick={() => void finishLater()}
            >
              Finish later
            </Button>
          </div>
        </form>
      )}
      <p className="border-t border-ink-rule pt-5 text-sm text-ink-muted">
        This prepares you to plan. Research, some drafting paths, and sending may need additional
        setup. Onboarding does not enable finders, run research, or send messages. Wallets and
        sending accounts are optional here.
      </p>
    </div>
  );
}
