/**
 * Fetches an Agora RTC token from the Supabase Edge Function.
 * The token is generated server-side using the Agora App Certificate,
 * which is never exposed to the client.
 */
export interface AgoraTokenResponse {
  token: string;
  uid: number;
  expireTs: number;
  appId: string;
  channelName: string;
}

export async function fetchAgoraToken(
  channel: string,
  uid: number,
): Promise<AgoraTokenResponse> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error("Server configuration is missing.");
  }

  const apiUrl = `${supabaseUrl}/functions/v1/agora-token?channel=${encodeURIComponent(channel)}&uid=${uid}`;

  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Token service error (${response.status})`);
  }

  const data = await response.json();

  if (!data.token || !data.appId) {
    throw new Error("Invalid token response from server.");
  }

  return data as AgoraTokenResponse;
}
