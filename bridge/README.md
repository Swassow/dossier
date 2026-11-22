# Use your Claude subscription instead of an API key

Upstream Dossier reaches Claude through the Anthropic API, which needs an API key with paid credit. This fork adds a small **bridge** that runs on your own computer and answers Dossier's API calls with **Claude Code** (`claude -p`), signed in with your Claude Pro or Max plan. AI work then counts against your plan's usage limits, not API credit.

Dossier itself is unchanged: it still thinks it's talking to the Anthropic API. So you can keep using the official Docker image and its updates.

```
Dossier (Docker) ──HTTP──▶ bridge (your Mac, :8787) ──▶ claude -p ──▶ your Claude subscription
```

## Setup

1. Install Claude Code and sign in with your subscription (once):

   ```bash
   claude
   ```

   then type `/login` and pick your Claude account. Quit with `/exit`.

2. Start the bridge (needs Node 20+). Leave this terminal open:

   ```bash
   ./bridge/start.sh
   ```

   It makes a random token in `~/.config/dossier-bridge/token` the first time, and prints the settings below.

3. Point Dossier at it. Either add these to the `.env` next to your `compose.yml` and run `docker compose up -d`:

   ```
   DOSSIER_AI_PROVIDER=anthropic
   DOSSIER_AI_URL=http://host.docker.internal:8787
   DOSSIER_AI_KEY=<contents of ~/.config/dossier-bridge/token>
   DOSSIER_AI_MODEL=claude-sonnet-5-5
   DOSSIER_AI_TIMEOUT_SECONDS=600
   ```

   or enter the same in **Settings → AI provider → Anthropic** (address, API key = the token, model). A provider saved in Settings wins over `.env`.

4. In Settings → AI provider, press **Test connection**.

## Options (environment variables)

| Variable | Default | |
|---|---|---|
| `BRIDGE_PORT` | `8787` | |
| `BRIDGE_HOST` | `127.0.0.1` | Docker Desktop (Mac/Windows) reaches this through `host.docker.internal`. On Linux Docker use `0.0.0.0` (the token still guards it). |
| `BRIDGE_MAX_CONCURRENT` | `2` | How many `claude` processes run at once; the rest wait. |
| `BRIDGE_TIMEOUT_SECONDS` | `600` | |
| `BRIDGE_MODELS` | `claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5` | What Settings offers. Any name `claude --model` takes works. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI. |

## How it works, and limits

- Each request runs `claude -p` in an empty temp folder with **no tools, no MCP servers and no settings files**, with Dossier's system prompt replacing Claude Code's own, so the model only writes text.
- Structured answers (Dossier's JSON schemas) use `claude --json-schema`.
- `ANTHROPIC_API_KEY` is removed from the child's environment so Claude Code always uses your subscription login.
- Each call starts a CLI process, so expect a few seconds more per call than the API.
- No streaming, no per-call `max_tokens`, temperature or effort: Dossier works without them.
- Your plan's usage limits apply. When you hit one, Dossier shows a rate-limit error until it resets.
- Use it for your own Dossier on your own machine. Anthropic's terms don't allow offering subscription access to other people through an app.
