# Hosting the coach bridge (so friends can use it while your laptop is closed)

The extension's coach talks to `bridge/coach_server.py`. On your Mac that's
`127.0.0.1:8000`, which dies the moment your laptop sleeps. To make the coach
available "whenever", the same script runs on an always-on server with your
API key, and each friend's extension points at it with their own **access code**.

Nothing about the extension changes for you: leave ⚙ → coach server blank and
it keeps using the bridge on your Mac.

## What friends do (30 seconds)

1. Load the extension (chrome://extensions → Developer mode → Load unpacked → the repo folder).
2. Open the side panel → ⚙ → **coach server**: paste the server address
   (e.g. `https://focus-agent-bridge.fly.dev`).
3. **access code**: paste the code you gave them.
4. The brain badge should say **🧠 Claude (API, hosted)**. If it says
   **🔒 wrong access code**, the code is off.

## Access codes

One per friend, so you can see who's using it (the server log prints
`[coach] alice chat api 2400ms ok`) and cut one off without touching the others.
Every code is capped at `FA_DAILY_CAP` coach calls per day (default 300 — a
heavy homework night is maybe 40).

Mint one locally:

```bash
python3 bridge/coach_server.py token alice
# access code for alice: k3J9...
```

For the hosted server, collect them into one env var:
`FA_TOKENS=alice:k3J9...,bob:Qm2x...`

## Option A — Fly.io (recommended: sleeps when idle, ~$0-3/month)

Needs an account with a card on file (a parent's — you're under 18). One-time:

```bash
brew install flyctl
fly auth login
cp deploy/fly.toml ./fly.toml
fly launch --copy-config --no-deploy      # accept the app name or pick one
fly secrets set ANTHROPIC_API_KEY=sk-ant-... FA_TOKENS=alice:...,bob:...
fly deploy
fly status                                # → the URL, e.g. https://focus-agent-bridge.fly.dev
curl https://focus-agent-bridge.fly.dev/health
```

Adding a friend later: `fly secrets set FA_TOKENS=...` with the new list (it restarts the app).
Logs: `fly logs`. Cost: `fly dashboard` → billing. The machine stops when idle
and wakes on the first request, so the first coach reply of the evening takes an extra second or two.

## Option B — any Linux VPS (Hetzner CX22 ≈ €4/mo, DigitalOcean $6/mo)

```bash
# on the server, once
sudo useradd -r -m focus
sudo git clone <your repo> /opt/focus-agent
sudo pip3 install anthropic
sudo tee /opt/focus-agent/.env <<'ENV'
ANTHROPIC_API_KEY=sk-ant-...
FA_TOKENS=alice:...,bob:...
ENV
sudo chown -R focus:focus /opt/focus-agent && sudo chmod 600 /opt/focus-agent/.env
sudo cp /opt/focus-agent/deploy/focus-agent-bridge.service /etc/systemd/system/
sudo systemctl enable --now focus-agent-bridge
```

Then put it behind HTTPS (Caddy is two lines: `your.domain { reverse_proxy 127.0.0.1:8000 }`)
— the extension will happily talk plain `http://IP:8000`, but the access codes
would travel unencrypted, so use HTTPS for anything beyond a test.

## What the server refuses on purpose

- Starting hosted (`FA_HOST` not loopback) with no access codes.
- `/voice/local` from anywhere but the machine it runs on — that endpoint reads
  the owner's essay files.
- The API key never leaves the server. It is not in the extension, not in
  Chrome storage, not in the repo.

## Watching spend

Anthropic Console → Usage. Set a monthly spend limit there before handing out
codes. Claude Opus 5 at effort medium runs roughly 1-4¢ per coach reply;
five friends doing real homework is on the order of $10-30/month. Drop
`FA_API_MODEL=claude-sonnet-5` in the secrets if that's too much.
