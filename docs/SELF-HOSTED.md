# Self-hosted backend

Automaton originally depended on Conway Cloud for everything outside the agent loop: the sandbox VM, the credit balance that decides survival, inference fallback, domains, and the API key that SIWE provisioning hands out. When that service is unreachable the automaton cannot even start.

The **self-hosted backend** runs the same runtime with no Conway account:

| Concern | `backend: "conway"` (original) | `backend: "self-hosted"` |
|---|---|---|
| Agent's shell and files | Conway sandbox VM | this host (`local`) or a Docker container (`docker`) |
| Child sandboxes | Conway VMs | Docker containers (labelled `dev.automaton.sandbox=1`) |
| Credits (survival) | Conway balance | local ledger in `state.db`: funded credits minus recorded inference spend |
| Topups (USDC → credits) | x402 payment to Conway | **disabled**: no USDC is ever sent to Conway |
| Credit transfers to children | Conway API | signed credit vouchers |
| Inference | Conway Compute, or your own keys | your own keys (OpenAI, Anthropic) or Ollama only; never Conway |
| Domains / DNS | Conway | not available (tools return a clear error) |
| Registration | Conway API | local no-op (ERC-8004 on-chain identity is unchanged) |
| Wallet, x402 payments to third parties, on-chain identity, self-modification, replication | unchanged | unchanged |

## Setup

Run `automaton --setup` and choose `self-hosted` (the default). Or edit `~/.automaton/automaton.json`:

```json
{
  "backend": "self-hosted",
  "selfHosted": {
    "sandbox": "local",
    "dockerImage": "node:22-bookworm",
    "runtimeRepoUrl": "https://github.com/Conway-Research/automaton.git",
    "shareProviderKeysWithChildren": false,
    "childOllamaBaseUrl": "http://host.docker.internal:11434"
  },
  "inferenceModel": "claude-opus-5-5",
  "anthropicApiKey": "sk-ant-...",
  "ollamaBaseUrl": "http://localhost:11434"
}
```

- `sandbox: "local"` runs the agent's `exec` tool directly on this machine, as your user. The sandbox home `/root` maps to your home directory. Use it only on a machine or VM you are willing to hand to the agent.
- `sandbox: "docker"` sends `exec` and file tools into an existing container. Set `containerName` to a running container (for example `docker run -d --name automaton-main node:22-bookworm sleep infinity`).
- `runtimeRepoUrl` is what children `git clone` to install the runtime. Point it at your fork so children run this revived code, not upstream.
- Set `modelStrategy.lowComputeModel` to a model you actually have. The default `gpt-5-mini` needs an OpenAI key.

## Funding

Credits are a local budget for inference spend:

```bash
automaton-cli fund 5.00
```

The balance is everything ever funded, plus vouchers received, minus everything recorded in `inference_costs`. When it reaches zero the automaton dies, exactly as before. USDC sent to the agent's wallet stays there for x402 payments to third parties. In self-hosted mode it does not turn into credits.

In self-hosted mode, credits are accounting, not money. The real bills for BYOK inference go to whoever owns the API keys. Set `treasuryPolicy.maxInferenceDailyCents` and provider-side spend limits to match.

## Children and credit vouchers

A child gets a `genesis.json` with `backend: "self-hosted"`, configures itself from it non-interactively on first `--run`, and runs `local` inside its own container. Provider keys are passed only if `shareProviderKeysWithChildren` is true. They go into a separate `bootstrap-secrets.json`, which the state repo ignores and which is deleted once copied into `automaton.json`.

`fund_child` / `transfer_credits` debit the parent's ledger and drop a voucher, signed with the parent's wallet key, into the child's `~/.automaton/credit-vouchers/`. The child accepts a voucher only if:

- it is addressed to the child's wallet,
- the signature recovers to its `parentAddress` or `creatorAddress`, and
- its id was never imported before.

A child cannot mint credits by writing files. If delivery fails, the parent is refunded. Vouchers are EVM-only for now.

## Testing against real Docker

The normal test suite mocks Docker. To run the driver and voucher delivery against a real daemon (starts and removes a few `alpine:3.20` containers):

```bash
AUTOMATON_DOCKER_IT=1 pnpm vitest run src/__tests__/backends/docker.integration.test.ts
```

Use `AUTOMATON_DOCKER_IT_IMAGE` to test another image.

## Not covered yet

- Exposing ports of a Docker sandbox after it was created. Publish ports at `docker run` time instead.
- Grandchildren: a child inside a container has no Docker daemon, so its `spawn_child` fails cleanly.
- Turning earned USDC into ledger credits. Today only the creator (`automaton-cli fund`) and the parent (vouchers) add credits.
- The social relay still defaults to `social.conway.tech`. Set `socialRelayUrl` to your own relay or remove it.
