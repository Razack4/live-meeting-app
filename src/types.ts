export interface VideoSelection {
  file: File;
  url: string;
}

export const ACCEPTED_VIDEO_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
];

export function isAcceptableVideo(file: File): boolean {
  if (ACCEPTED_VIDEO_TYPES.includes(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "webm", "mov"].includes(ext);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Single Room Mode ─────────────────────────────────────────────────
// All calls share ONE fixed Agora channel. The access code is used only
// to look up call state in Supabase, not to determine the Agora channel.

export const FIXED_CHANNEL = "main-call-room";

export type CallStatus = "waiting" | "active" | "ended";

export interface CallRecord {
  id: string;
  access_code: string;
  channel_name: string;
  status: CallStatus;
  host_display_name: string | null;
  created_at: string;
  ended_at: string | null;
}

/** Generate a 6-digit numeric access code. */
export function generateAccessCode(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** Build a shareable link in the format: origin/call/847291 */
export function buildShareableLink(accessCode: string): string {
  const base = window.location.origin;
  return `${base}/call/${accessCode}`;
}

/**
 * Extract the access code from the URL.
 * Supports both /call/847291 (new format) and ?room=ft-xxxx (legacy).
 */
export function getAccessCodeFromUrl(): string | null {
  const path = window.location.pathname;
  const callMatch = path.match(/^\/call\/(\d+)$/);
  if (callMatch) return callMatch[1];

  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room) return room;

  return null;
}

export type ConnectionState =
  | "idle"
  | "initializing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";
