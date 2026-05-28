import { createAuthorizationCode, exchangeAuthorizationCode, hasMcpOAuthSecret, isMcpOAuthSetupKey } from "../auth/oauth";
import type { Env } from "../types";
import { json } from "../utils/json";

const CLIENT_ID_PREFIX = "aelios-client-";
const TEXT_ENCODER = new TextEncoder();

function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "www-authenticate"
  });
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders()) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function originFromRequest(request: Request): string {
  return new URL(request.url).origin;
}

function authServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["memory:read", "memory:write"]
  };
}

function protectedResourceMetadata(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  const origin = url.origin;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/mcp`
  };
}

function readParam(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function base64UrlEncodeText(text: string): string {
  let binary = "";
  for (const byte of TEXT_ENCODER.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function readRequestData(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }

  const form = await request.formData();
  const data: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") data[key] = value;
  }
  return data;
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f5; color: #1f2523; }
    main { max-width: 520px; margin: 10vh auto; padding: 28px; background: white; border: 1px solid #deded8; border-radius: 10px; box-shadow: 0 12px 34px rgba(0,0,0,.08); }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { line-height: 1.55; color: #59605b; }
    label { display: block; font-size: 13px; font-weight: 650; margin: 18px 0 8px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #c9cbc6; border-radius: 7px; padding: 11px 12px; font-size: 15px; }
    button { margin-top: 20px; width: 100%; border: 0; border-radius: 7px; padding: 11px 14px; background: #1f6f5b; color: white; font-size: 15px; font-weight: 700; cursor: pointer; }
    .error { color: #a33b28; }
    code { background: #f1f1ed; padding: 2px 5px; border-radius: 5px; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" }
    }
  );
}

function hiddenInput(name: string, value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<input type="hidden" name="${name}" value="${escaped}">`;
}

function authorizeForm(url: URL, message = ""): Response {
  const fields = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method"
  ]
    .map((key) => hiddenInput(key, url.searchParams.get(key) || ""))
    .join("\n");

  return htmlPage(
    "Authorize Aelios Memory",
    `<h1>连接 Aelios 记忆 MCP</h1>
<p>请输入你的 <code>MEMORY_MCP_API_KEY</code> 或 <code>CHATBOX_API_KEY</code>。通过后，客户端会拿到一个临时 OAuth access token，不会保存你的原始 key。</p>
${message ? `<p class="error">${message}</p>` : ""}
<form method="post" action="/oauth/authorize">
  ${fields}
  <label for="api_key">API Key</label>
  <input id="api_key" name="api_key" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">授权连接</button>
</form>`
  );
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (!hasMcpOAuthSecret(env)) {
    return htmlPage("OAuth Not Configured", "<h1>OAuth 未配置</h1><p>请先设置 CHATBOX_API_KEY 或 MEMORY_MCP_API_KEY。</p>", 500);
  }

  if (request.method === "GET") return authorizeForm(new URL(request.url));

  const data = await readRequestData(request);
  const apiKey = readParam(data, "api_key");
  if (!isMcpOAuthSetupKey(env, apiKey)) {
    const retryUrl = new URL(request.url);
    for (const key of [
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method"
    ]) {
      const value = readParam(data, key);
      if (value) retryUrl.searchParams.set(key, value);
    }
    return authorizeForm(retryUrl, "API key 不正确。");
  }

  const responseType = readParam(data, "response_type");
  const clientId = readParam(data, "client_id");
  const redirectUri = readParam(data, "redirect_uri");
  if (responseType !== "code" || !clientId || !redirectUri) {
    return json({ error: "invalid_request" }, { status: 400 });
  }

  const code = await createAuthorizationCode(env, {
    clientId,
    redirectUri,
    scope: readParam(data, "scope") || "memory:read memory:write",
    codeChallenge: readParam(data, "code_challenge") || undefined,
    codeChallengeMethod: readParam(data, "code_challenge_method") || undefined
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = readParam(data, "state");
  if (state) redirect.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  const data = await readRequestData(request);
  if (readParam(data, "grant_type") !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const exchanged = await exchangeAuthorizationCode(env, {
    code: readParam(data, "code"),
    clientId: readParam(data, "client_id"),
    redirectUri: readParam(data, "redirect_uri"),
    codeVerifier: readParam(data, "code_verifier") || undefined
  });

  if (!exchanged) return json({ error: "invalid_grant" }, { status: 400 });

  return json({
    access_token: exchanged.accessToken,
    token_type: "Bearer",
    expires_in: exchanged.expiresIn,
    scope: exchanged.scope
  });
}

async function handleRegister(request: Request): Promise<Response> {
  const data = await readRequestData(request);
  const redirectUris = readStringArray(data, "redirect_uris");
  const clientName = readParam(data, "client_name") || "MCP Client";
  const rawClientId = `${clientName}:${redirectUris.join(",")}:${Date.now()}`;
  const clientId = `${CLIENT_ID_PREFIX}${base64UrlEncodeText(rawClientId)}`;

  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    },
    { status: 201 }
  );
}

export function oauthChallengeHeaders(request: Request): Headers {
  const headers = corsHeaders();
  headers.set(
    "www-authenticate",
    `Bearer resource_metadata="${originFromRequest(request)}/.well-known/oauth-protected-resource"`
  );
  return headers;
}

export async function handleOAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return withCors(json(protectedResourceMetadata(request)));
  }

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return withCors(json(authServerMetadata(originFromRequest(request))));
  }

  if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return withCors(json(authServerMetadata(originFromRequest(request))));
  }

  if (url.pathname === "/oauth/authorize" && (request.method === "GET" || request.method === "POST")) {
    return withCors(await handleAuthorize(request, env));
  }

  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return withCors(await handleToken(request, env));
  }

  if (url.pathname === "/oauth/register" && request.method === "POST") {
    return withCors(await handleRegister(request));
  }

  return null;
}
