# Privacy

Last updated: 2 November 2026.

Leanfare runs on your computer. It has no server of its own and no account, and it sends nothing about you to the people who make it. There is no telemetry, and nothing is sold or shared: there is nothing to share. This covers the Leanfare app, its MCP server and its plugin for Claude.

## What it reads

1. The task your AI app hands it, and the files that app names for it. Only those: files that hold secrets (like `.env` files and private keys) are refused.
2. The API keys of the providers you connect: from the macOS Keychain on a Mac, else from a file only you can read, or from your environment where you keep them.
3. Usage numbers your AI apps write on your computer (Claude Code's status line, and the token counts in Claude Code's and Codex's log files), to show how much of a plan is left. From each log line it takes the model, the time and the token counts and drops the rest: no message text is kept, shown or sent. It never uses their sign ins.

## Where it sends things

1. The task and those files go only to the model providers you connected (OpenAI, Anthropic, Google, Groq, OpenRouter and the others you add), each under its own terms and privacy policy; to your ChatGPT plan through Codex, if you connected it; or to models on your computer (Ollama). A task marked private stays on your computer.
2. Some free plans let the provider read and use what you send to improve its products (Google's free Gemini plan, Mistral's free plan). Leanfare marks those plans, and private work never goes to them.
3. To check a key, Leanfare asks the provider for its model list or, for OpenRouter, the key's own details (which include the day the key expires). No tokens are used.
4. It downloads public lists that carry nothing about you: model prices (a file on GitHub), models.dev's list of providers, and, unless you turn it off, the newest version from GitHub's releases. As with any download, those sites see your computer's internet address.

## What it keeps

1. Numbers about each hand off: the time, the model, the tokens, the cost, the grade. They stay in Leanfare's folder on your computer (`~/.leanfare`) until you delete them.
2. The words of a hand off (its task, answer, file names and file text) only if you turn that on in Settings. They are kept 7 to 90 days (30 at first), on your computer, and **Delete all kept words** removes them.
3. Nothing it keeps leaves your computer.

## Deleting everything

Quit Leanfare and delete its folder, `~/.leanfare`. Your keys in the macOS Keychain are under "leanfare" in Keychain Access.

## Children

Leanfare is a tool for people who work with AI apps, and it is not meant for children.

## Changes

Changes to this policy come with Leanfare's releases, and the changelog says what changed.

## Questions

Open an issue at [github.com/pouriaetab/leanfare/issues](https://github.com/pouriaetab/leanfare/issues). For something you would rather not post in public, see [SECURITY.md](SECURITY.md).
