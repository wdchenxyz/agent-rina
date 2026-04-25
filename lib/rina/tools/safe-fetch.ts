import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_REDIRECTS = 4;

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; RinaBot/1.0; +https://github.com/wdchenxyz/agent-rina)",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  isAllowedContentType?: (contentType: string) => boolean;
}

export interface SafeFetchResult {
  finalUrl: string;
  contentType: string;
  buffer: Buffer;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hostnameLooksLocal(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".localdomain") ||
    lower.endsWith(".home.arpa") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".test") ||
    lower.endsWith(".invalid") ||
    !lower.includes(".")
  );
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return false;

  if (lower.startsWith("::ffff:")) {
    return isPublicIpv4(lower.slice("::ffff:".length));
  }

  const firstSegment = lower.split(":").find((segment) => segment.length > 0) ?? "0";
  const first = Number.parseInt(firstSegment, 16);
  if (!Number.isFinite(first)) return false;

  return !(
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    lower.startsWith("2001:db8:")
  );
}

function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

export async function assertSafePublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are supported.");
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not supported.");
  }

  const hostname = url.hostname;
  const version = isIP(hostname);
  if (version !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new UnsafeUrlError("Private, loopback, and reserved IP addresses are blocked.");
    }
    return;
  }

  if (hostnameLooksLocal(hostname)) {
    throw new UnsafeUrlError("Local or internal hostnames are blocked.");
  }

  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) {
    throw new UnsafeUrlError("Hostname did not resolve to a public address.");
  }

  for (const address of addresses) {
    if (!isPublicIpAddress(address.address)) {
      throw new UnsafeUrlError("Hostname resolves to a private or reserved address.");
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readCappedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let received = 0;

  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

export async function safeFetchBuffer(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = new URL(rawUrl);
  const headers = new Headers(DEFAULT_HEADERS);
  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafePublicUrl(currentUrl);

    const response = await fetchWithTimeout(
      currentUrl.toString(),
      {
        headers,
        redirect: "manual",
      },
      timeoutMs,
    );

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect from ${currentUrl.hostname} did not include a Location header.`);
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (options.isAllowedContentType && !options.isAllowedContentType(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
    }

    const contentLength = parseContentLength(response.headers);
    if (contentLength !== null && contentLength > options.maxBytes) {
      throw new Error(`Response is too large (${(contentLength / (1024 * 1024)).toFixed(1)} MB).`);
    }

    const buffer = await readCappedBuffer(response, options.maxBytes);
    return {
      finalUrl: currentUrl.toString(),
      contentType,
      buffer,
    };
  }

  throw new Error(`Too many redirects; stopped after ${maxRedirects}.`);
}

export function decodeResponseText(buffer: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim();
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}
