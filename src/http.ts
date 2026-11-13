import { ActionError } from "./model.js";
export type Fetch = typeof fetch;
export async function request(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
  phase: string,
  timeoutMs = 30000,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch {
    throw new ActionError(
      "upstream_unavailable",
      phase,
      `Network request failed during ${phase}`,
    );
  }
}
export async function json(
  response: Response,
  phase: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ActionError(
      "invalid_response",
      phase,
      `Invalid JSON during ${phase}`,
    );
  }
}
export async function oidc(
  audience: string,
  fetcher: Fetch = fetch,
): Promise<string> {
  // Read only when requesting a token, never copy the request credential into records or files.
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !credential)
    throw new ActionError(
      "oidc_unavailable",
      "oidc",
      "id-token: write permission is required",
    );
  const url = new URL(endpoint);
  url.searchParams.set("audience", audience);
  const response = await request(
    fetcher,
    url.href,
    { headers: { Authorization: `Bearer ${credential}` } },
    "oidc",
  );
  if (!response.ok)
    throw new ActionError(
      "unauthenticated",
      "oidc",
      "GitHub OIDC request failed",
    );
  const body = (await json(response, "oidc")) as { value?: unknown };
  if (typeof body?.value !== "string" || !body.value)
    throw new ActionError("invalid_response", "oidc", "Missing OIDC token");
  return body.value;
}
