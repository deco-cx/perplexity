import { createTool } from "@deco/workers-runtime/mastra";
import type { Env } from "../main.ts";
import z from "zod";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.enum(["text", "image_url"]),
        text: z.string().optional(),
        image_url: z
          .object({
            url: z.string().url(),
          })
          .optional(),
      }).strict(),
    ),
  ]),
});

const SearchModeSchema = z.enum(["academic", "web"]);
const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
const SearchContextSizeSchema = z.enum(["low", "medium", "high"]);

const WebSearchOptionsSchema = z
  .object({
    search_context_size: SearchContextSizeSchema.optional(),
    user_location: z
      .object({
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        country: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
      })
      .optional(),
    image_search_relevance_enhanced: z.boolean().optional(),
  })
  .strict()
  .optional();

// Response schemas derived from the YAML spec
const UsageInfoSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  search_context_size: z.string().nullable().optional(),
  citation_tokens: z.number().nullable().optional(),
  num_search_queries: z.number().nullable().optional(),
  reasoning_tokens: z.number().nullable().optional(),
});

const ApiPublicSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  date: z.string().nullable().optional(),
});

const ChatMessageContentChunkSchema = z.object({
  type: z.enum(["text", "image_url"]),
  text: z.string().optional(),
  image_url: z
    .object({
      url: z.string().url(),
    })
    .optional(),
});

const ChatCompletionsMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(ChatMessageContentChunkSchema)]),
});

const ChatCompletionsChoiceSchema = z.object({
  index: z.number(),
  finish_reason: z.enum(["stop", "length"]).nullable().optional(),
  message: ChatCompletionsMessageSchema,
});

const ChatCompletionsResponseJsonSchema = z.object({
  id: z.string(),
  model: z.string(),
  created: z.number(),
  usage: UsageInfoSchema,
  object: z.literal("chat.completion"),
  choices: z.array(ChatCompletionsChoiceSchema),
  search_results: z.array(ApiPublicSearchResultSchema).nullable().optional(),
});

type ChatCompletionsResponse = z.infer<
  typeof ChatCompletionsResponseJsonSchema
>;

const BasePerplexityParamsSchema = {
  search_mode: SearchModeSchema.optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  max_tokens: z.number().int().positive().optional().default(16000).describe(
    "The maximum number of tokens to generate. The default is 16000.",
  ),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  search_domain_filter: z.array(z.string()).max(10).optional(),
  return_images: z.boolean().optional(),
  return_related_questions: z.boolean().optional(),
  search_recency_filter: z.string().optional(),
  search_after_date_filter: z.string().optional(),
  search_before_date_filter: z.string().optional(),
  last_updated_after_filter: z.string().optional(),
  last_updated_before_filter: z.string().optional(),
  top_k: z.number().optional(),
  stream: z.boolean().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  // Spec only guarantees an object; allow passthrough keys
  response_format: z.object({}).passthrough().optional(),
  disable_search: z.boolean().optional(),
  enable_search_classifier: z.boolean().optional(),
  web_search_options: WebSearchOptionsSchema,
};

const ModelSchema = z.enum([
  "sonar",
  "sonar-pro",
  "sonar-deep-research",
  "sonar-reasoning",
  "sonar-reasoning-pro",
]);

function ensureApiKey(env: Env): string {
  const key =
    (env as unknown as { PERPLEXITY_API_KEY?: string }).PERPLEXITY_API_KEY;
  if (!key) {
    throw new Error(
      "Missing PERPLEXITY_API_KEY in environment. Add it to wrangler.toml [vars].",
    );
  }
  return key;
}

function extractTextFromContent(
  content: unknown,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content as Array<
      { type: string; text?: string; image_url?: { url: string } }
    >;
    return parts
      .map((p) => (p.type === "text" ? p.text || "" : ""))
      .join("")
      .trim();
  }
  return "";
}

async function callPerplexity(
  env: Env,
  body: Record<string, unknown>,
): Promise<ChatCompletionsResponse> {
  const apiKey = ensureApiKey(env);
  const res = await fetch(PERPLEXITY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Perplexity API error: ${res.status} ${res.statusText} - ${text}`,
    );
  }
  const data = await res.json();
  // Validate against the schema to ensure structure
  return ChatCompletionsResponseJsonSchema.parse(data);
}

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
      const inputTokens = context.query.length / 4;
      const { transactionId, totalAmount } = await env.PERPLEXITY_CONTRACT
        .CONTRACT_AUTHORIZE({
          clauses: [
            {
              clauseId: "sonar:input-token",
              amount: inputTokens,
            },
            {
              clauseId: "sonar:output-token",
              amount: context.max_tokens,
            },
          ],
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
      const response = await env.PERPLEXITY_CONTRACT.CONTRACT_SETTLE({
        transactionId,
        vendorId: env.DECO_CHAT_WORKSPACE,
        clauses: [
          {
            clauseId: "sonar:input-token",
            amount: Math.min(inputTokens, json.usage.prompt_tokens),
          },
          {
            clauseId: "sonar:output-token",
            amount: Math.min(json.usage.completion_tokens, context.max_tokens),
          },
        ],
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
      const body: Record<string, unknown> = {
        model: context.model ?? "sonar",
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
      const first = json?.choices?.[0]?.message?.content;
      const answer = extractTextFromContent(first) || undefined;
      return { answer, raw: json };
    },
  });

export const perplexityTools = [
  createAskPerplexityTool,
  createPerplexityChatCompletionsTool,
];
