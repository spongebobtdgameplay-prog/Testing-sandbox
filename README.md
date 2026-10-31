# Testing Sandbox

A Node.js + PostgreSQL friends/presence app with private one-to-one WebRTC voice and optional video calls.

## What is included

- Account creation and sign-in using bcrypt password hashes.
- HttpOnly, SameSite session cookies. Raw session tokens are not stored in PostgreSQL.
- Username search and friend requests.
- Online/offline presence through authenticated Socket.IO connections.
- One-to-one voice calls and optional video calls using browser WebRTC.
- Socket.IO is used only for call invitations and offer/answer/ICE signaling. WebRTC encrypts audio/video in transit and sends it directly where possible, or through a configured TURN relay when direct connectivity is blocked. The application server does not receive or record the media.
- Microphone and camera permissions are requested only after the user accepts or joins a call.
- PostgreSQL tables are created with idempotent migrations on startup. Tables use the `sandbox_` prefix to avoid colliding with unrelated tables in the supplied database.

## Deploy on Render

The Render web service is already connected to this repository and uses:

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node.js

Before accounts can work, add a **newly rotated** PostgreSQL connection string as the Render service environment variable:

- `DATABASE_URL` — PostgreSQL connection string with SSL required.

Do not put a real connection string in GitHub, source files, screenshots, or issue reports. The database credential previously pasted into chat should be rotated before the app is connected to the database.

Optional TURN configuration improves call success when users are on restrictive Wi-Fi, mobile networks, or symmetric NAT:

- `TURN_URLS` — comma-separated TURN/TURNS URLs.
- `TURN_SHARED_SECRET` — the TURN REST API shared secret. The app derives short-lived (one-hour) TURN credentials server-side; the shared secret is never returned to browsers.

The app includes a public STUN server fallback. STUN alone cannot guarantee a connection across every network. For dependable real-world calling, configure a TURN provider or your own TURN server with the REST API authentication enabled.

After setting environment variables, Render will restart/redeploy the service. Check `/api/health`; it should report `{"status":"ok","database":"connected"}`.

## Local development

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in a local/test `DATABASE_URL`.
4. Run `npm start`.
5. Open `http://localhost:10000`.

Camera and microphone access require a secure context: HTTPS in production, or localhost during local development.

## Database tables

- `sandbox_users`: usernames and bcrypt password hashes.
- `sandbox_sessions`: hashed session tokens and expiry.
- `sandbox_friend_requests`: pending, accepted, and declined friend relationships.

The application does not store microphone audio, webcam video, call recordings, or WebRTC media streams.
