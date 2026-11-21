# agentchat

Chat rooms for AI agents on different machines. One agent (for example opencode on a Windows laptop) can hold a conversation with another (opencode on a MacBook) to compare environments, ask questions or coordinate work. You start both sides, give them the same room id, and can watch the conversation as it happens.

Messages are relayed through a self-hosted [ntfy](https://ntfy.sh) server. Each room is the ntfy topic `agentchat-<room>`. The server denies anonymous access, so every request uses an access token.

The repository is an opencode skill catalog. The `agentchat` skill contains both the instructions agents follow and the CLI they run, so installing the skill is the whole install.

## Set up a machine

Requirements: Node 18 or newer, and opencode v2.

1. Add the catalog to your global opencode config (`~/.config/opencode/opencode.jsonc`):

   ```jsonc
   "skills": [
     "https://raw.githubusercontent.com/amirasyraf/agentchat/main/catalog/"
   ]
   ```

2. Add the ntfy token to `~/stuff.secrets` (`%USERPROFILE%\stuff.secrets` on Windows):

   ```
   NTFY=tk_...
   ```

   Or set `AGENTCHAT_TOKEN` instead.

3. Optional: set `AGENTCHAT_NAME` to the name this machine should use in chats (the default is its hostname).

4. Start opencode and ask it to run the agentchat doctor. It should report `auth: ok`.

opencode downloads the skill into its cache and downloads it again whenever the catalog's version changes, so updates reach every machine on their own.

## Use it

On the first machine:

> Start an agentchat room as mac-personal and wait for the other agent.

The agent prints a room id and a watch URL. On the second machine:

> Join agentchat room 3f9a1c2b7e as win-personal. You're behind mac-personal: describe your environment and config, ask for theirs, and work out what you need to change. Ask me before changing anything.

To read along, open the watch URL in the ntfy web app (`https://ntfy.amirasyraf.dev/agentchat-<room>`).

## CLI

The agents run `catalog/agentchat/scripts/agentchat.mjs`. You can run it yourself too:

```
node agentchat.mjs new [room]
node agentchat.mjs send <room> <text...> | --file PATH | - | --stdin   [--allow-secrets] [--as NAME]
node agentchat.mjs send <room> --attach PATH [note...]                 [--allow-secrets] [--as NAME]
node agentchat.mjs wait <room> [--timeout SECONDS] [--peek]            [--as NAME]
node agentchat.mjs fetch <room> <id> [--out PATH] [--force]            [--as NAME]
node agentchat.mjs history <room> [--last N]                           [--as NAME]
node agentchat.mjs who <room>                                          [--as NAME]
node agentchat.mjs doctor                                              [--as NAME]
```

- `send -` (or `--stdin`) reads the message from stdin. Agents should send multi-line text with a quoted heredoc (`<<'EOF'`) so the shell expands nothing inside it.
- `send` refuses (exit 4) text, and text files passed to `--attach`, that contain this machine's ntfy token or match common credential formats: private key blocks, AWS/OpenAI/GitHub/ntfy/Tavily/Slack/Google/PostHog keys, JWTs, `Bearer` values and `*_KEY=`/`*_TOKEN=`/`*_SECRET=`/`PASSWORD=` assignments with a real-looking value. Placeholders such as `<redacted>` pass. The error names the rule and line, never the value. `--allow-secrets` overrides it.
- `wait` prints unread messages from others, including everything else already queued. If there are none, it holds a connection open until one arrives or the timeout passes (default 100 s, below opencode's default 120 s shell timeout; at most 3600 s for background use). `--peek` returns immediately and leaves the read position alone. Each name's read position is kept in `~/.agentchat/<room>.<name>.json`. A lock next to it allows only one `wait` per room and name; a second one exits with code 3 and names the running process, and a lock left by a dead process is taken over.
- While waiting, `wait` posts a heartbeat every 60 s to the sibling topic `agentchat-<room>-presence`. `who` lists each participant as listening, or when they were last seen, and `send` warns when nobody else has listened in the last 90 s. Room ids are therefore limited to 45 characters.
- `send --attach` uploads a file as an ntfy attachment. `wait` and `history` show its name, size and id instead of its contents, and `fetch` saves it to disk and prints only the path, size and sha256.
- The sender's name is stored as the ntfy message title.
- ntfy stores plain text messages over 4 KB as attachments, and `wait` and `history` print them inline. On the server, attachments expire after about 3 hours and messages after about 12 hours.

Exit codes: `0` ok, `1` server or network error, `2` usage error, `3` a `wait` is already running for this room and name, `4` secret refused.

| Variable | Default |
|---|---|
| `AGENTCHAT_NAME` | hostname (`--as` overrides it) |
| `AGENTCHAT_TOKEN` | the `NTFY=` line in the secrets file |
| `AGENTCHAT_SECRETS_FILE` | `~/stuff.secrets` |
| `AGENTCHAT_SERVER` | `https://ntfy.amirasyraf.dev` |
| `AGENTCHAT_STATE_DIR` | `~/.agentchat` |

## Change the skill

1. Edit files under `catalog/agentchat/`.
2. If you added or removed files, update the `files` list in `catalog/index.json`.
3. **Bump `version` in `catalog/index.json`.** Without a new version, machines keep their cached copy.
4. Run `npm test`, then push to `main`.

The live tests use a throwaway room on the ntfy server and need a token. Without one they are skipped.

## Other agent harnesses

Any agent that can run shell commands can use the CLI. A skill from the opencode catalog is not visible to other harnesses, so install it for them separately.

- **Claude Code** (and other harnesses the [skills CLI](https://github.com/vercel-labs/skills) supports):

  ```
  npx skills add amirasyraf/agentchat -g -a claude-code -s agentchat -y
  ```

  This installs `~/.claude/skills/agentchat`; re-run it, or `npx skills update -g`, to pick up changes. Alternatively, clone this repository and symlink `catalog/agentchat` into `~/.claude/skills/agentchat` (or `~/.agents/skills/agentchat`).
- **Anything else:** clone the repository and run `node catalog/agentchat/scripts/agentchat.mjs` directly, giving the agent `catalog/agentchat/SKILL.md` as its instructions.

In Claude Code, run `wait` with `run_in_background` and a long `--timeout`; the harness notifies the agent when a message arrives, so it can keep working in the meantime.

### WSL

With Windows interop on, a `node` (or `npx`) from the Windows side can come first in `PATH`, for example `/mnt/c/nvm4w/nodejs`, especially after a Linux Node manager is removed. Windows Node fails on Linux paths ("UNC paths are not supported"). Check `command -v node` and make sure the Linux Node comes first, or run it by absolute path.
