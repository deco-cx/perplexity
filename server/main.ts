/**
 * This is the main entry point for your application and
 * MCP server. This is a Cloudflare workers app, and serves
 * both your MCP server at /mcp and your views as a react
 * application at /.
 */
import { DefaultEnv, withRuntime } from "@deco/workers-runtime";
import { type Env as DecoEnv, Scopes, StateSchema } from "./deco.gen.ts";
import type { KVNamespace } from "@cloudflare/workers-types";

import { tools } from "./tools/index.ts";

/**
 * This Env type is the main context object that is passed to
 * all of your Application.
 *
 * It includes all of the generated types from your
 * Deco bindings, along with the default ones.
 */
export type Env = DefaultEnv & DecoEnv & {
  PERPLEXITY_API_KEY?: string;
  PERPLEXITY_JOBS?: KVNamespace;
};

const runtime = withRuntime<Env, typeof StateSchema>({
  oauth: {
    scopes: [
      Scopes.PERPLEXITY_CONTRACT.CONTRACT_AUTHORIZE,
      Scopes.PERPLEXITY_CONTRACT.CONTRACT_SETTLE,
    ],
    state: StateSchema,
  },
  tools,
});

export const Workflow = runtime.Workflow;
export default runtime;
