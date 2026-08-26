// Auth headers for the self-hosted backend (Ollama / ComfyUI on the Mac
// mini). The token is an opaque string handed in by the caller, so this
// stays env-free and isomorphic:
//
//   "id:secret"  → Cloudflare Access service-token headers (the deployed
//                  Worker reaching the mini through its tunnel)
//   "anything"   → plain bearer (a reverse proxy checking Authorization)
//   ""           → no headers (localhost during wrangler dev)

export function localAuthHeaders(token: string): Record<string, string> {
  if (!token) return {};
  const colon = token.indexOf(":");
  if (colon > 0) {
    return {
      "CF-Access-Client-Id": token.slice(0, colon),
      "CF-Access-Client-Secret": token.slice(colon + 1),
    };
  }
  return { Authorization: `Bearer ${token}` };
}
