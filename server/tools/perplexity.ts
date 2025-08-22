import { createTool } from "@deco/workers-runtime/mastra";
import type { Env } from "../main.ts";
import z from "zod";
import {
  BasePerplexityParamsSchema,
  ModelSchema,
  ChatMessageSchema,
  callPerplexity,
  extractTextFromContent,
  ChatCompletionsResponseJsonSchema,
  estimateInputTokensFromMessages,
  estimateSearchQueries,
} from "./utils/perplexity.ts";

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
        inputTokens: z.number(),
        totalAmount: z.string(),
      })
      .strict(),
    execute: async ({ context }) => {
      const model = context.model ?? "sonar";
      const prefix = model;
      const inputTokens = Math.ceil(context.query.length / 4);

      const authorizeClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: inputTokens },
        { clauseId: `${prefix}:output-token`, amount: context.max_tokens ?? 0 },
      ];
      if (model === "sonar-deep-research") {
        authorizeClauses.push(
          { clauseId: `${prefix}:citation-token`, amount: context.max_tokens ?? 0 },
          { clauseId: `${prefix}:reasoning-token`, amount: context.max_tokens ?? 0 },
          { clauseId: `${prefix}:search-query`, amount: estimateSearchQueries(context.reasoning_effort) },
        );
      }
      const { transactionId, totalAmount } = await env.PERPLEXITY_CONTRACT.CONTRACT_AUTHORIZE({
        clauses: authorizeClauses,
      });
      const body: Record<string, unknown> = {
        model: context.model ?? "sonar",
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

      // Force non-streaming for tool response
      body.stream = false;

      const json = await callPerplexity(env, body);
      const first = json?.choices?.[0]?.message?.content;
      const answer = extractTextFromContent(first) || "";
      const settleClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: Math.min(inputTokens, json.usage.prompt_tokens) },
        { clauseId: `${prefix}:output-token`, amount: Math.min(json.usage.completion_tokens, context.max_tokens ?? json.usage.completion_tokens) },
      ];
      if (model === "sonar-deep-research") {
        const citation = json.usage.citation_tokens ?? 0;
        const reasoning = json.usage.reasoning_tokens ?? 0;
        const queries = json.usage.num_search_queries ?? 0;
        settleClauses.push(
          { clauseId: `${prefix}:citation-token`, amount: Math.min(citation, context.max_tokens ?? citation) },
          { clauseId: `${prefix}:reasoning-token`, amount: Math.min(reasoning, context.max_tokens ?? reasoning) },
          { clauseId: `${prefix}:search-query`, amount: Math.min(queries, estimateSearchQueries(context.reasoning_effort)) },
        );
      }
      await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: settleClauses,
      });

      return { answer, raw: json, inputTokens, totalAmount };
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
      const model = context.model ?? "sonar";
      const prefix = model;
      const inputTokens = estimateInputTokensFromMessages(context.messages);

      const authorizeClauses: Array<{ clauseId: string; amount: number }> = [
        { clauseId: `${prefix}:input-token`, amount: inputTokens },
        { clauseId: `${prefix}:output-token`, amount: context.max_tokens ?? 0 },
      ];
      if (model === "sonar-deep-research") {
        authorizeClauses.push(
          { clauseId: `${prefix}:citation-token`, amount: context.max_tokens ?? 0 },
          { clauseId: `${prefix}:reasoning-token`, amount: context.max_tokens ?? 0 },
          { clauseId: `${prefix}:search-query`, amount: estimateSearchQueries(context.reasoning_effort) },
        );
      }
      const { transactionId } = await env.PERPLEXITY_CONTRACT.CONTRACT_AUTHORIZE({ clauses: authorizeClauses });

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
        { clauseId: `${prefix}:input-token`, amount: Math.min(inputTokens, json.usage.prompt_tokens) },
        { clauseId: `${prefix}:output-token`, amount: Math.min(json.usage.completion_tokens, context.max_tokens ?? json.usage.completion_tokens) },
      ];
      if (model === "sonar-deep-research") {
        const citation = json.usage.citation_tokens ?? 0;
        const reasoning = json.usage.reasoning_tokens ?? 0;
        const queries = json.usage.num_search_queries ?? 0;
        settleClauses.push(
          { clauseId: `${prefix}:citation-token`, amount: Math.min(citation, context.max_tokens ?? citation) },
          { clauseId: `${prefix}:reasoning-token`, amount: Math.min(reasoning, context.max_tokens ?? reasoning) },
          { clauseId: `${prefix}:search-query`, amount: Math.min(queries, estimateSearchQueries(context.reasoning_effort)) },
        );
      }
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

export const perplexityTools = [
  createAskPerplexityTool,
  createPerplexityChatCompletionsTool,
];
