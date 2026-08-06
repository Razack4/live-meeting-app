const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_SERVER_URL || "/token";

export interface TokenResponse {
  token: string;
  appId: string;
  uid: number;
}

export async function fetchToken(
  channel: string,
  uid: number = 0,
  retries = 3,
): Promise<TokenResponse> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const url = `${TOKEN_ENDPOINT}?channel=${encodeURIComponent(channel)}&uid=${uid}`;
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Token server returned ${res.status}`);
      }

      return (await res.json()) as TokenResponse;
    } catch (err) {
      lastError = err as Error;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  throw lastError ?? new Error("Failed to fetch token");
}
