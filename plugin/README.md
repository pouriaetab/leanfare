# Leanfare for Claude

Leanfare makes your Claude plan last longer. It hands simple work, like reading big files, searching, drafting and checking, to cheaper or free models you pick, and gives Claude back a short answer with a receipt. Claude reviews and grades each answer before it answers you, and Leanfare's page shows what it kept out of your plan and what it cost.

This plugin connects Claude to the Leanfare app on your computer. It does not contain the app.

## Before you install

1. Install Leanfare, free and open source: on macOS or Linux run `curl -fsSL https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.sh | sh`, or see the [install steps](https://github.com/pouriaetab/leanfare#get-started) for Windows and the Mac app.
2. Open it once (`leanfare`) and add a model: an API key you have, OpenRouter's free models, or Ollama on your computer.
3. If you already pressed **Turn on Leanfare** in the app, Claude Code has Leanfare's tools and hooks already, and you don't need this plugin there. The plugin's hooks stay quiet when the app's own are in place.

## What the plugin adds

- **Leanfare's tools** (an MCP server that runs `leanfare mcp` on your computer): `level`, `plan`, `plan_run`, `plan_status`, `delegate`, `grade`, `report`, `live` and the rest, as the app's guide describes.
- **Four hooks** in Claude Code and Cowork, each running the installed Leanfare (`scripts/leanfare.sh`): before each prompt, a short line with how much of your Claude plan is left; before Claude reads a big file itself, one reminder that Leanfare can read it; after a hand off, its number, so the review can ask for a grade; before Claude finishes, one request to grade any hand off it did not grade.
- **A skill** that tells Claude when to hand work to Leanfare and how to review what comes back.

## What it sends, and what it keeps

The plugin itself sends nothing anywhere. Leanfare, when Claude hands it work, sends that task and the files Claude names to the model providers you added keys for (OpenAI, Anthropic, Google and others, under their own terms), or to models on your computer (Ollama), and nowhere else. A task marked private stays on your computer. Leanfare keeps numbers about each hand off (models, tokens, costs, grades) in its own folder on your computer, and keeps the words only if you choose that in its settings. No telemetry.

## Remove it

Uninstall the plugin from Claude. To stop Leanfare everywhere, turn it off with the switch at the top of its page, or run `leanfare stop`.

## Licence

MIT. Source and guide: [github.com/pouriaetab/leanfare](https://github.com/pouriaetab/leanfare).
