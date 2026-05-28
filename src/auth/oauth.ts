import type { Env } from "../types";

const TEXT_ENCODER = new TextEncoder();
const OAUTH_AUDIENCE = "aelios-mcp";
const ACCESS_TOKEN_SECONDS = 60 * 60 * 24 * 30;
const AUTH_CODE_SECONDS = 60 * 5;

interface SignedPayload {
  typ: "code" | "access";
  aud: typeof OAUTH_AUDIENCE;
  iat: number;
  exp: number;
  client_id: string;
  scope?: string;
}

interface AuthorizationCodePayload extends SignedPayload {
  typ: "code";
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

interface AccessTokenPayload extends SignedPayload {
  typ: "access";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(TEXT_ENCODER.encode(text));
}

function base64UrlDecodeText(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function getOAuthSecret(env: Env): string | null {
  return env.MEMORY_MCP_API_KEY?.trim() || env.CHATBOX_API_KEY?.trim() || null;
}

export function hasMcpOAuthSecret(env: Env): boolean {
  return getOAuthSecret(env) !== null;
}

export function isMcpOAuthSetupKey(env: Env, token: string): boolean {
  return Boolean(
    token &&
      ((env.MEMORY_MCP_API_KEY && token === env.MEMORY_MCP_API_KEY) ||
        (env.CHATBOX_API_KEY && token === env.CHATBOX_API_KEY))
  );
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signPayload(env: Env, payload: SignedPayload & Record<string, unknown>): Promise<string> {
  const secret = getOAuthSecret(env);
  if (!secret) throw new Error("OAuth is not configured");

  const body = base64UrlEncodeText(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), TEXT_ENCODER.encode(body));
  return `aelios_${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifySignedPayload(env: Env, token: string): Promise<SignedPayload | null> {
  const secret = getOAuthSecret(env);
  if (!secret || !token.startsWith("aelios_")) return null;

  const signed = token.slice("aelios_".length);
  const [body, signature] = signed.split(".");
  if (!body || !signature) return null;

  const expectedSignature = await crypto.subtle.sign("HMAC", await hmacKey(secret), TEXT_ENCODER.encode(body));
  if (signature !== base64UrlEncode(new Uint8Array(expectedSignature))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecodeText(body));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const record = payload as Partial<SignedPayload>;
  if (record.aud !== OAUTH_AUDIENCE) return null;
  if (record.exp === undefined || record.exp < Math.floor(Date.now() / 1000)) return null;
  if (record.typ !== "code" && record.typ !== "access") return null;
  if (!record.client_id) return null;
  return record as SignedPayload;
}

export async function createAuthorizationCode(
  env: Env,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope?: string;
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signPayload(env, {
    typ: "code",
    aud: OAUTH_AUDIENCE,
    iat: now,
    exp: now + AUTH_CODE_SECONDS,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: input.scope || "memory:read memory:write"
  } satisfies AuthorizationCodePayload);
}

export async function exchangeAuthorizationCode(
  env: Env,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier?: string;
  }
): Promise<{ accessToken: string; expiresIn: number; scope: string } | null> {
  const payload = await verifySignedPayload(env, input.code);
  if (!payload || payload.typ !== "code") return null;

  const codePayload = payload as AuthorizationCodePayload;
  if (codePayload.client_id !== input.clientId || codePayload.redirect_uri !== input.redirectUri) return null;

  if (codePayload.code_challenge) {
    const verifier = input.codeVerifier || "";
    if (!verifier) return null;

    if ((codePayload.code_challenge_method || "plain").toUpperCase() === "S256") {
      const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(verifier));
      if (base64UrlEncode(new Uint8Array(digest)) !== codePayload.code_challenge) return null;
    } else if (verifier !== codePayload.code_challenge) {
      return null;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const scope = codePayload.scope || "memory:read memory:write";
  const accessToken = await signPayload(env, {
    typ: "access",
    aud: OAUTH_AUDIENCE,
    iat: now,
    exp: now + ACCESS_TOKEN_SECONDS,
    client_id: input.clientId,
    scope
  } satisfies AccessTokenPayload);

  return { accessToken, expiresIn: ACCESS_TOKEN_SECONDS, scope };
}

export async function verifyMcpAccessToken(env: Env, token: string): Promise<boolean> {
  const payload = await verifySignedPayload(env, token);
  return payload?.typ === "access";
}
