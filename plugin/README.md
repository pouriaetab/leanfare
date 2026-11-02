# Leanfare for Claude

Leanfare makes your Claude plan last longer. It hands simple work, like reading big files, searching, drafting and checking, to cheaper or free models you pick, and gives Claude back a short answer with a receipt. Claude reviews and grades each answer before it answers you, and Leanfare's page shows what it kept out of your plan and what it cost.

This plugin connects Claude to the Leanfare app on your computer. It does not contain the app.

## Before you install

1. Install Leanfare, free and open source. Its [install steps](https://github.com/pouriaetab/leanfare#get-started) take one line in Terminal on macOS or Linux, or in PowerShell on Windows.
2. Open it once (`leanfare`) and connect a model: your ChatGPT plan, a free plan from Gemini, Groq or OpenRouter, an API key you have, or Ollama on your computer.
3. If you already pressed **Turn on Leanfare** in the app, Claude Code has Leanfare's tools and hooks already, and you don't need this plugin there. The plugin's hooks stay quiet when the app's own are in place.

## What the plugin adds

- **Leanfare's tools** (an MCP server that runs `leanfare mcp` on your computer): `level`, `plan`, `plan_run`, `plan_status`, `delegate`, `grade`, `report`, `live` and the rest, as the app's guide describes.
- **Four hooks** in Claude Code and Cowork, each running the installed Leanfare (`scripts/leanfare.sh`): before each prompt, a short line with how much of your Claude plan is left; before Claude reads a big file itself, one reminder that Leanfare can read it; after a hand off, its number, so the review can ask for a grade; before Claude finishes, one request to grade any hand off it did not grade.
- **A skill** that tells Claude when to hand work to Leanfare and how to review what comes back.

## What it sends, and what it keeps

The plugin itself sends nothing anywhere. Leanfare, when Claude hands it work, sends that task and the files Claude names to the model providers you added keys for (OpenAI, Anthropic, Google, Groq, OpenRouter and others, under their own terms), to your ChatGPT plan through Codex if you connected it, or to models on your computer (Ollama), and nowhere else. A task marked private stays on your computer. Leanfare keeps numbers about each hand off (models, tokens, costs, grades) in its own folder on your computer, and keeps the words only if you choose that in its settings. No telemetry.

## How it runs

- `scripts/leanfare.sh` starts the Leanfare you installed: `leanfare` on your PATH or in the folders its installers use (`~/.leanfare/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), or the one inside Leanfare.app. It downloads nothing and installs nothing. Without Leanfare, the hooks do nothing and the MCP server says how to install it.
- Leanfare has no runtime dependencies. Its development tools (TypeScript, Bun's types and happy-dom, for the tests) come from the public npm registry by name. The repository's `bunfig.toml` only holds test settings (a setup file and the test folder) and sets no registry.

## Remove it

Uninstall the plugin from Claude. To stop Leanfare everywhere, turn it off with the switch at the top of its page, or run `leanfare stop`.

## Licence

MIT. Source and guide: [github.com/pouriaetab/leanfare](https://github.com/pouriaetab/leanfare).
