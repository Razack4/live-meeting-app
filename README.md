# Live Meeting App

Production-ready video calling application powered by **Agora RTC SDK NG**. Works reliably across Wi-Fi, LTE, 4G, 5G, Carrier Grade NAT, and Symmetric NAT environments.

## Architecture

- **Frontend:** React + Vite + Tailwind CSS v4
- **Backend:** Lightweight Node.js server for Agora token generation
- **Video Engine:** Agora Web SDK NG (replaces PeerJS)

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
│   │   └── useCallTimer.ts     # Call duration timer
│   ├── lib/
│   │   ├── agora.ts             # Agora SDK re-export + types
│   │   ├── tokenService.ts     # Fetches temporary tokens from backend
│   │   └── createVideoStream.ts # Creates MediaStream from video file
│   ├── types.ts                 # Shared types and helpers
│   ├── App.tsx                  # Routes Host vs Guest based on ?room= param
│   ├── main.tsx
│   └── index.css
├── server/
│   ├── index.js                 # Token generation server
│   ├── package.json
│   └── .env.example
├── netlify.toml                 # Frontend deployment config
└── package.json
```

## Prerequisites

1. Create an Agora account at https://agora.io
2. Create a project and copy your **App ID** and **App Certificate**

## Local Development

### 1. Backend (token server)

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your Agora App ID and App Certificate
npm start
```

The server runs on `http://localhost:6060`.

### 2. Frontend

From the project root:

```bash
npm install
```

Create a `.env` file in the project root:

```env
VITE_TOKEN_SERVER_URL=http://localhost:6060/token
```

Start the dev server (Vite runs automatically in this environment):

```bash
npm run dev
```

## Deployment

### Frontend — Netlify

1. Connect this repository to Netlify
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Environment variable: `VITE_TOKEN_SERVER_URL` → your deployed backend URL + `/token`

The `netlify.toml` file is pre-configured with these settings.

### Backend — Render or Railway

1. Create a new Web Service pointing to the `server/` directory
2. Build command: `npm install`
3. Start command: `npm start`
4. Environment variables:
   - `AGORA_APP_ID` — your Agora App ID
   - `AGORA_APP_CERTIFICATE` — your Agora App Certificate
   - `PORT` — (optional, defaults to 6060)

## Environment Variables

### Frontend (`.env`)

| Variable | Description |
|---|---|
| `VITE_TOKEN_SERVER_URL` | Full URL of the token endpoint, e.g. `https://your-backend.onrender.com/token` |

### Backend (`server/.env`)

| Variable | Description |
|---|---|
| `AGORA_APP_ID` | Your Agora App ID |
| `AGORA_APP_CERTIFICATE` | Your Agora App Certificate (never expose in frontend) |
| `PORT` | Server port (default: 6060) |

## Features

- Camera on/off toggle
- Microphone mute/unmute
- Automatic reconnection after network interruption
- Connection status indicator (Connecting, Connected, Reconnecting, Error)
- Network loss detection with automatic rejoin
- Friendly loading and error states
- Proper track and client cleanup on leave
- Duplicate join prevention
