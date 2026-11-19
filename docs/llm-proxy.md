# Your own LLM proxy

Send the LLM calls through a Claude, Codex or Gemini subscription you already pay for, instead of a per-token API key.

## Run the proxy

Run [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), or another server that serves your subscriptions as an API. Log in to the accounts you want to use; its README lists a login command per provider. Add an entry under `api-keys` in its config: that is the key you paste below. It listens on `http://127.0.0.1:8317` by default.

## Point oneshot-gtm at it

In **Setup → LLM provider** (or the **Connect AI** step of Onboarding):

1. Pick **Your own proxy (CLIProxyAPI or similar)**.
2. Paste the endpoint URL and the proxy's API key.
3. Press **Load models** and pick one. The list is whatever the proxy's `/v1/models` returns. If it will not load, the error shows under the field and you can type the model id.

Claude models are called with the Anthropic API shape; every other model goes through OpenAI chat. You do not choose this.

The key is saved as `LLM_PROXY_API_KEY` in the workspace's `.env`.

## Set a fallback

Under **If this provider is down, use…**, pick a second provider and a model, for example OpenRouter with its key in Credentials. When the proxy is unreachable, times out, is rate-limited or refuses the key, the call goes to the fallback, and the fallback serves alone for about 10 minutes (longer if the proxy sent `Retry-After`, up to two hours). A bad request or an unknown model does not fail over: it would fail the same way there.

## Reasoning effort on OpenRouter

With OpenRouter as the provider, **Reasoning effort** (`llmReasoningEffort`: `low`, `medium`, `high` or `xhigh`; or `POST /api/setup`, `null` clears it) makes every model reason at that effort, including models that could have it off. Each call gets extra tokens on top of its answer budget: 1,536 at low, 4,096 at medium, 8,192 at high, 16,384 at xhigh. Unused tokens are not billed. A model that refuses the effort is asked at `low`, then with no effort. Unset: reasoning is off where the model allows it, else `low`. The fallback provider, the proxy and the Anthropic API ignore it.

## What still needs OpenRouter

The decisions engine (`engine: "decisions"` on the reply classifier or the offer judge) uses OpenRouter's decisions API and `OPENROUTER_API_KEY`, whatever the provider is.

## Cost

Proxy calls report no cost.

## Running it on another machine

Keep the proxy off the public internet. Reach it over an SSH tunnel (`ssh -N -L 8317:127.0.0.1:8317 <host>`, then use `http://127.0.0.1:8317`) or serve it over https. A plain `http://` address is accepted only on this machine (`localhost`, `127.x`, `::1`); anything else needs `https://` or a tunnel to a local port. The key is never sent through a redirect.

## Terms

Whether your subscription allows this, and how much it serves before it is rate-limited, is for you to check with the provider.
