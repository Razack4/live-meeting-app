# Live Meeting App

Production-ready video calling application powered by **Agora RTC SDK NG**. Works reliably across Wi-Fi, LTE, 4G, 5G, Carrier Grade NAT, and Symmetric NAT environments.

## Architecture

- **Frontend:** React + Vite + Tailwind CSS v4
- **Video Engine:** Agora Web SDK NG (App ID mode)

The Host selects a pre-recorded video, generates a shareable link, and waits. The Guest opens the link and joins with their real camera. Both see each other immediately.

## Project Structure

```
├── src/
│   ├── components/
│   │   ├── HostScreen.tsx       # Host setup + call screen
│   │   ├── GuestScreen.tsx      # Guest join + call screen
│   │   └── VideoCall.tsx        # Shared in-call UI (video, controls, status)
│   ├── hooks/
│   │   ├── useAgoraClient.ts    # Agora client lifecycle, reconnection, tracks
│   │   └── useCallTimer.ts      # Call duration timer
│   ├── lib/
│   │   ├── agora.ts             # Agora SDK re-export + App ID constant
│   │   └── createVideoStream.ts # Creates MediaStream from video file
│   ├── types.ts                 # Shared types and helpers
│   ├── App.tsx                  # Routes Host vs Guest based on ?room= param
│   ├── main.tsx
│   └── index.css
├── netlify.toml                 # Deployment config
└── package.json
```

## Prerequisites

No Agora project setup needed — the App ID is hardcoded in `src/lib/agora.ts`.

## Local Development

```bash
npm install
npm run dev
```

## Deployment

### Netlify

1. Connect this repository to Netlify
2. Build command: `npm run build`
3. Publish directory: `dist`

The `netlify.toml` file is pre-configured with these settings.

## Features

- Camera on/off toggle
- Microphone mute/unmute
- Automatic reconnection after network interruption
- Connection status indicator (Connecting, Connected, Reconnecting, Error)
- Network loss detection with automatic rejoin
- Friendly loading and error states
- Proper track and client cleanup on leave
- Duplicate join prevention
- Works on mobile 4G/LTE networks
