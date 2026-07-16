import assert from "node:assert/strict";
import test from "node:test";
import { AzureImageClient } from "./azure-image.js";

test("Azure image client uses Carmack-compatible image-2 request parameters", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new AzureImageClient(
    {
      baseUrl: "https://image.example/openai/v1",
      apiKey: "secret",
      deployment: "gpt-image-2",
      timeoutMs: 5_000,
    },
    async (input, init) => {
      request = { url: String(input), init: init as RequestInit };
      return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 });
    },
  );

  const result = await client.generate({
    prompt: "a clean spring campaign poster",
    aspectRatio: "9:16",
    quality: "medium",
    transparent: false,
  });

  assert.equal(result.model, "gpt-image-2");
  assert.equal(result.size, "1024x1536");
  assert.equal(result.b64Json, "aW1hZ2U=");
  assert.equal(request?.url, "https://image.example/openai/v1/images/generations");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    model: "gpt-image-2",
    prompt: "a clean spring campaign poster",
    size: "1024x1536",
    quality: "medium",
    background: "opaque",
    output_format: "png",
    n: 1,
  });
});

test("Azure image client fails clearly when credentials are absent", async () => {
  const client = new AzureImageClient({ deployment: "gpt-image-2", timeoutMs: 5_000 });
  await assert.rejects(
    client.generate({ prompt: "test" }),
    /AZURE_IMAGE_BASE_URL or AZURE_IMAGE_API_KEY/,
  );
});
