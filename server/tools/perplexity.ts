import { createTool } from "@deco/workers-runtime/mastra";
import type { Env } from "../main.ts";
import z from "zod";
import {
  AsyncApiChatCompletionsResponseSchema,
  BasePerplexityParamsSchema,
  callPerplexity,
  ChatCompletionsResponseJsonSchema,
  ChatMessageSchema,
  createPerplexityAsyncJob,
  estimateInputTokensFromMessages,
  estimateSearchQueries,
  extractTextFromContent,
  getPerplexityAsyncJob,
  ModelSchema,
} from "./utils/perplexity.ts";

type Clause = { clauseId: string; amount: number };

const createAskPerplexityTool = (env: Env) =>
  createTool({
    id: "ASK_PERPLEXITY",
    description:
      "Ask Perplexity with a simple prompt. Returns the first message content and raw response.",
    inputSchema: z
      .object({
        query: z.string().min(1),
        model: ModelSchema.optional().default("sonar"),
        ...BasePerplexityParamsSchema,
      })
      .strict(),
    outputSchema: z
      .object({
        answer: z.string(),
        raw: ChatCompletionsResponseJsonSchema,
      })
      .strict(),
    execute: async ({ context }) => {
      const toolStartTime = Date.now();
      const model = context.model;
      const prefix = model;
      const inputTokens = Math.ceil(context.query.length / 4);

      const authorizeClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: inputTokens },
        { clauseId: `${prefix}:output-token`, amount: context.max_tokens },
      ];

      const { transactionId } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({
          clauses: authorizeClauses,
        });
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "user", content: context.query },
        ],
      };

      for (const key of Object.keys(BasePerplexityParamsSchema)) {
        const k = key as keyof typeof BasePerplexityParamsSchema;
        if (context[k as keyof typeof context] !== undefined) {
          (body as any)[k] = context[k as keyof typeof context];
        }
      }

      // Force streaming for tool response
      body.stream = true;

      const json = await callPerplexity(env, body, toolStartTime);
      const first = json?.choices?.[0]?.message?.content;
      const answer = extractTextFromContent(first) || "";
      const settleClauses: Array<{ clauseId: string; amount: number }> = [
        {
          clauseId: `${prefix}:input-token`,
          amount: Math.min(inputTokens, json.usage.prompt_tokens),
        },
        {
          clauseId: `${prefix}:output-token`,
          amount: Math.min(
            json.usage.completion_tokens,
            context.max_tokens ?? json.usage.completion_tokens,
          ),
        },
      ];

      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });

      return { answer, raw: json };
    },
  });

const createPerplexityChatCompletionsTool = (env: Env) =>
  createTool({
    id: "PERPLEXITY_CHAT_COMPLETIONS",
    description:
      "Low-level Perplexity chat completions call mirroring the API options.",
    inputSchema: z
      .object({
        model: ModelSchema.default("sonar"),
        messages: z.array(ChatMessageSchema).min(1),
        ...BasePerplexityParamsSchema,
      })
      .strict(),
    outputSchema: z
      .object({
        answer: z.string().optional(),
        raw: ChatCompletionsResponseJsonSchema,
      })
      .strict(),
    execute: async ({ context }) => {
      const model = context.model
      const prefix = model;
      const inputTokens = estimateInputTokensFromMessages(context.messages);

      const authorizeClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: inputTokens },
        { clauseId: `${prefix}:output-token`, amount: context.max_tokens ?? 0 },
      ];

      const { transactionId } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({ clauses: authorizeClauses });

      const body: Record<string, unknown> = {
        model,
        messages: context.messages,
      };

      for (const key of Object.keys(BasePerplexityParamsSchema)) {
        const k = key as keyof typeof BasePerplexityParamsSchema;
        if (context[k as keyof typeof context] !== undefined) {
          (body as any)[k] = context[k as keyof typeof context];
        }
      }

      // Force non-streaming for tool response
      body.stream = false;

      const json = await callPerplexity(env, body);
      const settleClauses: Array<{ clauseId: string; amount: number }> = [
        {
          clauseId: `${prefix}:input-token`,
          amount: Math.min(inputTokens, json.usage.prompt_tokens),
        },
        {
          clauseId: `${prefix}:output-token`,
          amount: Math.min(
            json.usage.completion_tokens,
            context.max_tokens ?? json.usage.completion_tokens,
          ),
        },
      ];

      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });

      const first = json?.choices?.[0]?.message?.content;
      const answer = extractTextFromContent(first) || undefined;
      return { answer, raw: json };
    },
  });

const createPerplexityDeepResearchTool = (env: Env) =>
  createTool({
    id: "PERPLEXITY_DEEP_RESEARCH",
    description:
      "Create an async deep research job (sonar-deep-research). Returns request id and transaction info.",
    inputSchema: z
      .object({
        messages: z.array(ChatMessageSchema).min(1),
        ...BasePerplexityParamsSchema,
      })
      .strict(),
    outputSchema: z
      .object({
        request: AsyncApiChatCompletionsResponseSchema,
        transactionId: z.string(),
        totalAmount: z.string(),
        authorizedCaps: z
          .object({
            inputTokens: z.number(),
            maxTokens: z.number().optional(),
            searchQueries: z.number().optional(),
          })
          .strict(),
      })
      .strict(),
    execute: async ({ context }) => {
      const model = "sonar-deep-research";
      const prefix = model;
      const inputTokens = estimateInputTokensFromMessages(context.messages);
      const maxTokens = context.max_tokens ?? 0;
      const searchQueries = estimateSearchQueries(context.reasoning_effort);

      const authorizeClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: inputTokens },
        { clauseId: `${prefix}:output-token`, amount: maxTokens },
        {
          clauseId: `${prefix}:citation-token`,
          amount: Math.max(maxTokens, 50000),
        },
        {
          clauseId: `${prefix}:reasoning-token`,
          amount: Math.max(maxTokens, 100000),
        },
        { clauseId: `${prefix}:search-query`, amount: searchQueries },
      ];

      const { transactionId, totalAmount } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({
          clauses: authorizeClauses,
        });

      const requestBody: Record<string, unknown> = {
        model,
        messages: context.messages,
      };
      for (const key of Object.keys(BasePerplexityParamsSchema)) {
        const k = key as keyof typeof BasePerplexityParamsSchema;
        if (context[k as keyof typeof context] !== undefined) {
          (requestBody as any)[k] = context[k as keyof typeof context];
        }
      }
      (requestBody as any).stream = false;

      const asyncResp = await createPerplexityAsyncJob(env, requestBody);

      await env.PERPLEXITY_JOBS?.put(
        transactionId,
        JSON.stringify({
          authorizeClauses,
          asyncResp,
        }),
      );

      return {
        request: asyncResp,
        transactionId,
        totalAmount,
        authorizedCaps: {
          inputTokens,
          maxTokens,
          searchQueries,
        },
      };
    },
  });

const createGetPerplexityDeepResearchResultTool = (env: Env) =>
  createTool({
    id: "GET_PERPLEXITY_DEEP_RESEARCH_RESULT",
    description:
      "Get async deep research job status/result and settle contract accordingly.",
    inputSchema: z
      .object({
        transactionId: z.string(),
      }),
    outputSchema: z
      .object({
        status: z.enum(["CREATED", "IN_PROGRESS", "COMPLETED", "FAILED"]),
        response: ChatCompletionsResponseJsonSchema.nullable().optional(),
        error_message: z.string().nullable().optional(),
        settled: z.boolean(),
      })
      .strict(),
    execute: async ({ context }) => {
      const { transactionId } = context;
      const storedJob = await env.PERPLEXITY_JOBS?.get(transactionId);
      const parsedJob = storedJob ? JSON.parse(storedJob) : null;
      const asyncResp = await getPerplexityAsyncJob(
        env,
        parsedJob.asyncResp.id,
      );

      if (
        asyncResp.status === "CREATED" || asyncResp.status === "IN_PROGRESS"
      ) {
        return {
          status: asyncResp.status,
          response: null,
          error_message: asyncResp.error_message ?? null,
          settled: false,
        };
      }

      const model = asyncResp.model;
      const prefix = model;

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
        return {
          status: asyncResp.status,
          response: null,
          error_message: asyncResp.error_message ?? null,
          settled: true,
        };
      }

      const raw = asyncResp.response;

      if (!raw) {
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
        return {
          status: "COMPLETED" as const,
          response: null,
          error_message: null,
          settled: true,
        };
      }

      const usage = raw.usage;
      const settleClauses: Array<Clause> = [];

      const inputAmount = parsedJob.authorizeClauses.find((c: Clause) =>
        c.clauseId === `${prefix}:input-token`
      )?.amount ?? 0;
      const outputAmount = usage.completion_tokens;
      settleClauses.push({
        clauseId: `${prefix}:input-token`,
        amount: Math.min(inputAmount, usage.prompt_tokens),
      });
      settleClauses.push({
        clauseId: `${prefix}:output-token`,
        amount: Math.min(outputAmount, usage.completion_tokens),
      });

      const citation = usage.citation_tokens ?? 0;
      const reasoning = usage.reasoning_tokens ?? 0;
      const queries = usage.num_search_queries ?? 0;

      settleClauses.push({
        clauseId: `${prefix}:citation-token`,
        amount: Math.min(
          citation,
          parsedJob.authorizeClauses.find((c: Clause) =>
            c.clauseId === `${prefix}:citation-token`
          )?.amount ?? 0,
        ),
      });
      settleClauses.push({
        clauseId: `${prefix}:reasoning-token`,
        amount: Math.min(
          reasoning,
          parsedJob.authorizeClauses.find((c: Clause) =>
            c.clauseId === `${prefix}:reasoning-token`
          )?.amount ?? 0,
        ),
      });
      settleClauses.push({
        clauseId: `${prefix}:search-query`,
        amount: Math.min(
          queries,
          parsedJob.authorizeClauses.find((c: Clause) =>
            c.clauseId === `${prefix}:search-query`
          )?.amount ?? 0,
        ),
      });

      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });

      return {
        status: "COMPLETED" as const,
        response: raw,
        error_message: null,
        settled: true,
      };
    },
  });

export const perplexityTools = [
  createAskPerplexityTool,
  createPerplexityChatCompletionsTool,
  createPerplexityDeepResearchTool,
  createGetPerplexityDeepResearchResultTool,
];
