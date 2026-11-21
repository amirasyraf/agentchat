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
node agentchat.mjs send <room> <text...> | --file PATH | -   [--as NAME]
node agentchat.mjs wait <room> [--timeout SECONDS]           [--as NAME]
node agentchat.mjs history <room>                            [--as NAME]
node agentchat.mjs doctor                                    [--as NAME]
```

- `wait` prints unread messages from others. If there are none, it holds a connection open until one arrives or the timeout passes (default 100 s, below opencode's default 120 s shell timeout). Each name's read position is kept in `~/.agentchat/<room>.<name>.json`.
- The sender's name is stored as the ntfy message title.
- ntfy stores messages over 4 KB as attachments, and `wait` and `history` download them automatically. On the server, attachments expire after about 3 hours and messages after about 12 hours.

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

Any agent that can run shell commands can use the CLI. For harnesses that read `~/.agents/skills` or `~/.claude/skills`, clone this repository and symlink `catalog/agentchat` into that directory.
