# Perplexity MCP Integration for Deco

This app is a full-stack Deco MCP server + React frontend that exposes Perplexity AI search and chat capabilities via typed tools. It also demonstrates contract-based metering (authorize/settle) configured in `server/wrangler.toml` and enforced inside the tools.

## 📝 Development History

This repository uses [Specstory](https://specstory.com/) to track the history of
prompts that were used to code this repo. You can inspect the complete
development history in the [`.specstory/`](.specstory/) folder.

## ✨ Features

- **Perplexity tools**: `ASK_PERPLEXITY`, `PERPLEXITY_CHAT_COMPLETIONS`, `PERPLEXITY_DEEP_RESEARCH`, `GET_PERPLEXITY_DEEP_RESEARCH_RESULT`
- **Contract metering**: Tools pre-authorize estimated usage and settle actual usage after execution
- **🤖 MCP Server**: Cloudflare Workers-based server with typed tools and workflows
- **⚛️ React Frontend**: Modern React app with Vite, TanStack Router, and Tailwind CSS
- **🎨 UI Components**: Pre-configured shadcn/ui components for rapid development
- **🔧 Type Safety**: Full TypeScript support with auto-generated RPC client types
- **🚀 Hot Reload**: Live development with automatic rebuilding for both frontend and backend
- **☁️ Ready to Deploy**: One-command deployment to Cloudflare Workers

## 🚀 Quick Start

### Prerequisites

- Node.js ≥22.0.0
- [Deco CLI](https://deco.chat): `npm i -g deco-cli`

### Setup

```bash
# Install dependencies
npm install

# Configure your app
npm run configure

# Start development server
npm run dev
```

The server will start on `http://localhost:8787` serving both your MCP endpoints
and the React frontend.

Important:
- You must run `npm run gen` (type generation) and `npm run deploy` at least once before invoking contract-backed tools. This registers bindings and makes the contract available to the runtime.

## 📁 Project Structure

```
├── server/           # MCP Server (Cloudflare Workers + Deco runtime)
│   ├── main.ts      # Server entry point with tools & workflows
│   └── deco.gen.ts  # Auto-generated integration types
└── view/            # React Frontend (Vite + Tailwind CSS)
    ├── src/
    │   ├── lib/rpc.ts    # Typed RPC client for server communication
    │   ├── routes/       # TanStack Router routes
    │   └── components/   # UI components with Tailwind CSS
    └── package.json
```

## 🛠️ Development Workflow

- **`npm run dev`** - Start development with hot reload
- **`npm run gen`** - Generate types for external integrations
- **`npm run gen:self`** - Generate types for your own tools/workflows
- **`npm run deploy`** - Deploy to production

Note: Contracts require a deployed environment. Run `npm run gen` and `npm run deploy` before testing tools that call `PERPLEXITY_CONTRACT`.

## 💳 Contract Declaration (wrangler.toml)

This app declares a contract with clauses for Perplexity token usage in `server/wrangler.toml`. The binding makes a typed `PERPLEXITY_CONTRACT` available at runtime.

```18:23:server/wrangler.toml
[[deco.bindings]]
type = "contract"
name = "PERPLEXITY_CONTRACT"

[deco.bindings.contract]
body = "Perplexity AI Search Service\n\nThis service provides AI-powered search and chat completion capabilities through Perplexity AI's advanced language models.\n\nWhat you get:\n- Real-time web search: Get up-to-date information from across the internet\n- Academic search: Access scholarly articles and research papers\n- AI chat completions: Intelligent responses powered by Perplexity's Sonar models\n- Flexible search options: Customize search context, location, and reasoning depth\n"
```

Clauses define capped resources the tools can authorize and settle (prices are in micro-units per 1M tokens/queries):

```26:43:server/wrangler.toml
[[deco.bindings.contract.clauses]]
id = "sonar:input-token"
price = "1"
description = "Sonar input tokens - $1 per 1M tokens"

[[deco.bindings.contract.clauses]]
id = "sonar:output-token"
price = "1"
description = "Sonar output tokens - $1 per 1M tokens"
```

Additional clauses exist for `sonar-pro`, `sonar-reasoning`, and `sonar-deep-research` (input/output, citation, reasoning, and search queries). The API key for Perplexity is provided via `[vars]`.

## 🔒 How Tools Use the Contract (authorize & settle)

Each tool estimates usage, calls `CONTRACT_AUTHORIZE` with caps, performs the API call, then calls `CONTRACT_SETTLE` with actual usage:

Authorize in `ASK_PERPLEXITY`:
```49:53:server/tools/perplexity.ts
      const { transactionId } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({
          clauses: authorizeClauses,
        });
```

Settle in `ASK_PERPLEXITY`:
```87:91:server/tools/perplexity.ts
      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });
```

The same pattern applies to `PERPLEXITY_CHAT_COMPLETIONS`.

### Deep Research (async) flow

Deep Research authorizes multiple resources up front (input/output, citation, reasoning, search queries):
```202:219:server/tools/perplexity.ts
      const { transactionId, totalAmount } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({
          clauses: authorizeClauses,
        });
```

It stores the job and authorization context in KV to reconcile later:
```235:241:server/tools/perplexity.ts
      await env.PERPLEXITY_JOBS?.put(
        transactionId,
        JSON.stringify({
          authorizeClauses,
          asyncResp,
        }),
      );
```

When fetching results, the tool reads the stored authorization, checks job status, and settles accordingly:
```275:281:server/tools/perplexity.ts
      const parsedJob = storedJob ? JSON.parse(storedJob) : null;
      const asyncResp = await getPerplexityAsyncJob(
        env,
        parsedJob.asyncResp.id,
      );
```

On failure, settle all clauses with zero:
```296:307:server/tools/perplexity.ts
      if (asyncResp.status === "FAILED") {
        await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
          transactionId,
          vendorId: env.DECO_CHAT_WORKSPACE,
          clauses: [
            { clauseId: `${prefix}:input-token`, amount: 0 },
            { clauseId: `${prefix}:output-token`, amount: 0 },
            { clauseId: `${prefix}:citation-token`, amount: 0 },
            { clauseId: `${prefix}:reasoning-token`, amount: 0 },
            { clauseId: `${prefix}:search-query`, amount: 0 },
          ],
        });
```

On success, settle with actual usage bounded by the previously authorized caps:
```386:390:server/tools/perplexity.ts
      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });
```

## 🔗 Frontend ↔ Server Communication

The template includes a fully-typed RPC client that connects your React frontend
to your MCP server:

```typescript
// Typed calls to your server tools and workflows
const result = await client.MY_TOOL({ input: "data" });
const workflowResult = await client.MY_WORKFLOW({ input: "data" });
```

Perplexity tools are exposed directly on the client as well, e.g. `client.ASK_PERPLEXITY(...)` and `client.PERPLEXITY_DEEP_RESEARCH(...)`.

## 📖 Learn More

This template is built for deploying primarily on top of the
[Deco platform](https://deco.chat/about) which can be found at the
[deco-cx/chat](https://github.com/deco-cx/chat) repository.

Documentation can be found at [https://docs.deco.page](https://docs.deco.page)

---

**Deploy, run `npm run gen`, then try the Perplexity tools with contract-backed metering!**
