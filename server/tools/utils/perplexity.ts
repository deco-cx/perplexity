import type { Env } from "../../main.ts";
import z from "zod";

export const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
export const PERPLEXITY_ASYNC_CREATE_URL =
  "https://api.perplexity.ai/async/chat/completions";

export const ChatMessageSchema = z.object({
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

export const SearchModeSchema = z.enum(["academic", "web"]);
export const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
export const SearchContextSizeSchema = z.enum(["low", "medium", "high"]);

export const WebSearchOptionsSchema = z
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

export const UsageInfoSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  search_context_size: z.string().nullable().optional(),
  citation_tokens: z.number().nullable().optional(),
  num_search_queries: z.number().nullable().optional(),
  reasoning_tokens: z.number().nullable().optional(),
});

export const ApiPublicSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  date: z.string().nullable().optional(),
});

export const ChatMessageContentChunkSchema = z.object({
  type: z.enum(["text", "image_url"]),
  text: z.string().optional(),
  image_url: z
    .object({
      url: z.string().url(),
    })
    .optional(),
});

export const ChatCompletionsMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(ChatMessageContentChunkSchema)]),
});

export const ChatCompletionsChoiceSchema = z.object({
  index: z.number(),
  finish_reason: z.enum(["stop", "length"]).nullable().optional(),
  message: ChatCompletionsMessageSchema,
});

export const ChatCompletionsResponseJsonSchema = z.object({
  id: z.string(),
  model: z.string(),
  created: z.number(),
  usage: UsageInfoSchema,
  object: z.literal("chat.completion"),
  choices: z.array(ChatCompletionsChoiceSchema),
  search_results: z.array(ApiPublicSearchResultSchema).nullable().optional(),
});

export type ChatCompletionsResponse = z.infer<
  typeof ChatCompletionsResponseJsonSchema
>;

// Async endpoints
export const AsyncProcessingStatusSchema = z.enum([
  "CREATED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);

export const AsyncApiChatCompletionsResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  created_at: z.number(),
  started_at: z.number().nullable().optional(),
  completed_at: z.number().nullable().optional(),
  response: ChatCompletionsResponseJsonSchema.nullable().optional(),
  failed_at: z.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
  status: AsyncProcessingStatusSchema,
});

export type AsyncApiChatCompletionsResponse = z.infer<
  typeof AsyncApiChatCompletionsResponseSchema
>;

export const BasePerplexityParamsSchema = {
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
  response_format: z.object({}).passthrough().optional(),
  disable_search: z.boolean().optional(),
  enable_search_classifier: z.boolean().optional(),
  web_search_options: WebSearchOptionsSchema,
};

export const ModelSchema = z.enum([
  "sonar",
  "sonar-pro",
  "sonar-reasoning",
  "sonar-reasoning-pro",
]);

export function ensureApiKey(env: Env): string {
  const key = env.PERPLEXITY_API_KEY
  if (!key) {
    throw new Error(
      "Missing PERPLEXITY_API_KEY in environment. Add it to wrangler.toml [vars].",
    );
  }
  return key;
}

export function extractTextFromContent(content: unknown): string {
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

export async function callPerplexity(
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

  if (!data) {
    throw new Error("No valid data received from Perplexity API");
  }

  try {
    return ChatCompletionsResponseJsonSchema.parse(data);
  } catch (schemaError) {
    console.log(
      "Schema validation failed, attempting to return partial data:",
      schemaError,
    );
    // If we have data but it doesn't match the schema, try to extract what we can
    if (data && typeof data === "object" && "choices" in data) {
      console.log("Returning data with possible schema issues due to timeout");
      return data as ChatCompletionsResponse;
    }
    throw new Error(
      `Invalid response format from Perplexity API: ${
        schemaError instanceof Error ? schemaError.message : String(schemaError)
      }`,
    );
  }
}

export async function createPerplexityAsyncJob(
  env: Env,
  request: Record<string, unknown>,
): Promise<AsyncApiChatCompletionsResponse> {
  const apiKey = ensureApiKey(env);
  const res = await fetch(PERPLEXITY_ASYNC_CREATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Perplexity Async Create error: ${res.status} ${res.statusText} - ${text}`,
    );
  }
  const json = await res.json();
  return AsyncApiChatCompletionsResponseSchema.parse(json);
}

export async function getPerplexityAsyncJob(
  env: Env,
  requestId: string,
): Promise<AsyncApiChatCompletionsResponse> {
  const apiKey = ensureApiKey(env);
  const url = `${PERPLEXITY_ASYNC_CREATE_URL}/${encodeURIComponent(requestId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Perplexity Async Get error: ${res.status} ${res.statusText} - ${text}`,
    );
  }
  const json = await res.json();
  return AsyncApiChatCompletionsResponseSchema.parse(json);
}

export function estimateInputTokensFromMessages(
  messages: Array<z.infer<typeof ChatMessageSchema>>,
): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const chunk of m.content) {
        if (chunk.type === "text" && chunk.text) chars += chunk.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export function estimateSearchQueries(
  effort?: z.infer<typeof ReasoningEffortSchema>,
): number {
  if (effort === "low") return 10;
  if (effort === "high") return 60;
  return 30; // default / medium
}
