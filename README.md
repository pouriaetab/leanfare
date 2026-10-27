# Leanfare

Every top AI model in one app on your own computer, and on top of the AI apps you already use. Leanfare shows what each answer costs and how long it takes, picks the cheapest model that does the job well, keeps a monthly budget, and lets Claude hand reading work to cheaper models without losing quality.

- **Inside the apps you already use.** One press adds Leanfare's tools to Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code and LM Studio. You keep using them as usual; Leanfare works underneath.
- **Set up without typing.** Paste any API key and Leanfare knows whose it is. Keys in your environment (`OPENAI_API_KEY` and the like) are used as they are, and Find my keys offers the ones in other AI tools' files (llm, aider, Gemini CLI, Codex CLI, OpenCode, Continue), each used only after you tick it. Model apps running on your computer (Ollama, LM Studio, Jan, llama.cpp, vLLM, LocalAI, KoboldCpp, GPT4All, Lemonade) are found on their own.
- **Every top model, your own keys.** OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Perplexity, Groq, Cerebras, Together AI, Fireworks, OpenRouter (one key, many makers), local models, and any other provider that speaks OpenAI's format. No account, no markup, no middleman: requests go from your computer to the provider.
- **Subscriptions apart from pay per use.** Your Claude, ChatGPT, Perplexity, Google AI, Copilot and Cursor plans with their 5 hour, weekly or monthly limits, and what is left of them where your computer keeps the numbers; what your keys and credits spent, on its own.
- **The cost and the time of every answer.** An estimate before you send, with its time, and the exact cost after. At the same quality, choose the cheapest, the cheapest within a time, or the fastest.
- **Automatic model choice.** Leanfare guesses the task (coding, math, writing, long documents and more) and picks the cheapest model you ticked that rates well for it. Every answer says which model wrote it and why.
- **Claude hands work to cheaper models.** Through the `delegate` tool, Claude passes reading heavy work to the cheapest model that is good enough, and a stronger model checks a sample of the answers. **The trial** measures how well that goes on your own models before you rely on it.
- **A budget that holds.** Each request reserves the most it can cost before it goes out. A warning at 80%; at 100%, keep going on the cheapest model or stop.
- **A chat that does the everyday things.** Attach images, PDFs and text files. Edit a question, ask again, or ask another model and see both costs. Per chat instructions, readable thinking, search, export, and import from ChatGPT or Claude.
- **Light and private.** One program, one SQLite file, no telemetry, no runtime dependencies. Keys stay in your system's keychain, or a file only you can read. Leanfare reads usage numbers, never your words (see [Privacy](#privacy)).

## Install

macOS and Linux, in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.sh | sh
```

Windows, in PowerShell (new: tell us what breaks):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.ps1 | iex"
```

The installer downloads the one-file Leanfare for your computer from the latest release, checks it against the release's checksums, puts it in `~/.leanfare/bin` (`%LOCALAPPDATA%\Leanfare\bin` on Windows) and adds that folder to your PATH. Then:

```sh
leanfare
```

The app opens in your browser at `http://127.0.0.1:4747`. Run the installer again to update; Leanfare says when a new version is out.

Paste one key, or start free:

| Free way to start | How |
|---|---|
| Google Gemini | Make a free key at [Google AI Studio](https://aistudio.google.com/apikey) and paste it. On Google's free plan, Google may use your messages to improve its products. Tick "free plan" so its answers count as $0. |
| Local models | Install [Ollama](https://ollama.com/download) and pull a model (`ollama pull llama3.2`), or load one in [LM Studio](https://lmstudio.ai) and start its local server. Leanfare finds them on its own. |
| OpenRouter | Press **Connect OpenRouter** and sign in on OpenRouter's page: Leanfare gets a key with nothing to copy. Models whose name ends in `:free` cost nothing. |
| Groq | A free plan with daily limits: make a key at [console.groq.com](https://console.groq.com/keys) and paste it. |

**From the code**, with [Bun](https://bun.sh) 1.4:

```sh
git clone https://github.com/pouriaetab/leanfare.git
cd leanfare
bun src/cli.ts
```

Run `bun link` once to have the `leanfare` command everywhere.

**The Mac app.** With Apple's Command Line Tools (`xcode-select --install`) and Bun, from the same folder: `bash mac/build.sh --install`. Today's spend is in the menu bar, and Open Leanfare shows the chat.

## Use it in your apps

Settings, **In your apps**, lists the AI apps on this computer. **Add** puts Leanfare's tools in one; **Remove** takes them out. Leanfare changes only its own entry in each app's settings file, keeps a copy of the file as it was, and leaves a file it cannot read alone. In Terminal: `leanfare apps`, `leanfare apps add claude-desktop`, `leanfare apps remove cursor`.

The tools (an MCP server, `leanfare mcp`, which starts Leanfare when it is not running):

- **delegate** hands a task and its files to a cheaper model (below).
- **ask** sends a question through Leanfare, with its cost.
- **spend** says what was spent today and this month, the budget, and what Auto saved.
- **models** lists the models you ticked, with prices and ratings.
- **estimate** prices a prompt before sending it: the model Auto would pick, its time, and at the same quality the cheapest and the fastest choice.
- **trial** runs the trial (below) and reports on it.

To add it by hand, the command is the `leanfare` program with the argument `mcp`, for example in Claude Desktop's settings file (Settings, Developer, Edit Config):

```json
{ "mcpServers": { "leanfare": { "command": "/Users/you/.leanfare/bin/leanfare", "args": ["mcp"] } } }
```

It speaks the 2026-07-28 protocol and the earlier ones.

### Hand work to cheaper models (delegate)

Claude stays in charge and hands pieces of work to Leanfare: searching or summarizing big files, logs or many documents, reviewing a file, drafting a section. Leanfare reads the files itself, so their text never enters Claude's context, picks the cheapest model you ticked that rates well enough, and answers briefly with a receipt:

```
(Leanfare delegate: DeepSeek V4 Flash, $0.0004. Checked by Gemini 3.8 Flash: passed ($0.0011). About 54,000 tokens of files stayed out of your context; this answer is about 300. It took about 6 s.)
```

- **Effort.** `low` takes the cheapest model rated within 80 points of the best you ticked (Save more), `medium` within 40 (Balanced), `high` within 15 (Best quality). It is also the thinking effort for models that think.
- **Kind.** `read` (find, pull out, summarize), `write` (draft text or code) or `reason` (work something out) decides which Arena rating counts.
- **Speed.** `cheapest`, `fastest` or a number of seconds, as in [Speed](#speed); by default your choice in Settings.
- **Checks.** A model rated above the one that answered checks every high effort answer, 1 in 4 medium ones and 1 in 10 low ones. A failed answer is asked again one tier up, with the checker's reason. Neither a check nor a second try goes past your budget.
- **Files.** Text files only: at most 50, 2 MB each, 4 MB in all. Files that hold secrets are never read: `.env` files and their kin, private keys and certificates, credential and token files, and anything in `.ssh`, `.gnupg`, `.aws`, `.git`, a keychain or Leanfare's own folder.

### The trial: measure it before you rely on it

Ten questions with known answers about files Leanfare makes up (a server log, a settings file, orders, code, release notes, a team list and a long access log), each asked the way Claude asks at low, medium and high effort: 30 answers, graded by code. It says which effort passes (at most one miss) on the models you ticked, and gives the line to put in `CLAUDE.md` so Claude hands reading work over on its own:

```
To read large files or logs, use the leanfare delegate tool with effort medium, and work from its answer.
```

Run it from the Savings page (**Run the trial**), in Terminal (`leanfare trial`), or ask Claude to use the trial tool. It costs what its answers and checks cost on your models ($0 on free plans) and shows the estimate first. The files are the same on every computer, so results compare across people: **Share on GitHub** opens an issue with the numbers filled in, for you to read and send yourself. Nothing is sent on its own.

## Set up without typing

- **Paste any key.** One box in Settings takes a key from any provider: Leanfare tells by its shape whose it is (patterns from gitleaks), tests it with that provider and saves it. A key it cannot place offers to add its provider.
- **Keys in your environment** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GROQ_API_KEY` and the like) are used without pasting. A Leanfare that did not start from a terminal (the Mac app, or an app starting it for its tools) asks your login shell for the ones its settings export, and keeps only variables whose names end in `_KEY`. Settings shows where each key came from; one from your environment or your shell's settings is removed there, not in Leanfare.
- **Find my keys** looks in your environment and your login shell's, and in the key files of llm, aider, Gemini CLI, Codex CLI (only an API key login), OpenCode (only API keys) and Continue. You see each key's last four characters and where it was; tick the ones to use. A key for a provider Leanfare does not have yet (from models.dev's list, by its `*_API_KEY` name) is offered unticked, with the address it would go to. Subscription logins (Claude's, ChatGPT's, Gemini CLI's) and general tokens (`GITHUB_TOKEN` and the like) are never used.
- **Model apps on this computer** are found by asking the usual local addresses which models they serve.
- **Add a provider.** Any service that speaks OpenAI's format: pick it from the list of known providers (from models.dev, with its address and prices) or type its name and address.

## Your subscriptions and pay per use

Savings shows two things apart:

- **Your subscriptions.** Pick your plans in Settings (Claude Pro or Max, ChatGPT Go, Plus, Pro or Business, Perplexity Pro or Max, Google AI Plus, Pro or Ultra, Copilot Pro or Pro+, Cursor Pro or Ultra; the price can be edited). Each shows its limits: a 5 hour window and a week for Claude and Codex, weekly or monthly allowances for the others.
  - **Claude:** what this month's Claude Code use would cost at API prices, and what is left of the 5 hours and the week, from Claude Code's status line (**Add to the status line** on the Savings page).
  - **ChatGPT:** the same from Codex's own log files, which also name your plan, so Leanfare offers it.
  - **Perplexity, Google AI, Copilot and Cursor** keep no usage numbers on your computer: Leanfare shows their limits, and a link to their own usage page where they have one.
- **Pay per use: what your keys and credits spent through Leanfare.** The spend, what Auto saved, the budget, and each answer's cost.

**What is left** is shown in dollars of work and tokens at your recent mix, with a 90% range, and **what still fits** says how many typical sessions of each project fit before the limit. Anthropic's terms do not let other apps use a Claude Pro or Max login, so Leanfare only counts: it never sends a request on your plan.

## Speed

Every estimate shows its time next to its price: the wait for the first words plus the time to write the answer, measured from each model's own answers on your computer (a rough guess, said as such, until a model has answered three times). In Settings, and beside the message box for Auto, choose:

- **The cheapest**, however long it takes (the default).
- **The cheapest within about a minute, 20 seconds or 5 seconds.** If none is expected in time, the fastest.
- **The fastest**, whatever it costs.

Quality stays the same: speed only chooses among the models within reach of the best for the task. A cheaper model is sometimes the faster one too.

## The chat

- **Files.** Drop, paste or attach images, PDFs and text or code files. Images go to models that see images, PDFs to models that read them; Auto picks among those.
- **Edit, again, another model.** Change any question and send it again, or ask another model and keep both answers, with how many times cheaper or dearer the new one was.
- **Instructions, thinking, second tries.** Each chat can have its own instructions; a thinking model's thoughts are shown folded; an answer that comes back empty or cut off is asked for once more.
- **Your chats.** Search them, export one or all, and import your history from ChatGPT or Claude. History can be turned off; the cost ledger never keeps what you wrote.

## Use it from your scripts

Point anything that speaks OpenAI's or Anthropic's format at Leanfare. Leanfare uses the keys you saved in it.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4747/v1", api_key="leanfare")
reply = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
```

- **Model names:** `auto`, `auto-save`, `auto-balanced`, `auto-best`, or a model id such as `google/gemini-3.8-flash`. `GET /v1/models` lists the ones you ticked. Anthropic's format: `http://127.0.0.1:4747/v1/messages`.
- **Headers on every answer:** `x-leanfare-model`, `x-leanfare-cost-usd`, `x-leanfare-estimate-usd`, `x-leanfare-estimate-seconds`, `x-leanfare-task` and `x-leanfare-reason`.
- **Per request:** `x-leanfare-mode: save`, `balanced` or `best`, and `x-leanfare-speed: cheapest`, `fastest` or a number of seconds.
- **An access key.** Turn on "Other apps need a key" in Settings and apps need Leanfare's key (`lf-...`) as their API key. Web pages on other sites are refused unless you allow their address.

## How Auto picks

1. **Task guess.** Rules read the conversation: code gives *coding*, equations *math*, "write a story" *creative writing*, a long paste or a PDF *long prompts*, and so on; otherwise *everyday questions*. The guess and its reason are shown on every answer.
2. **Best value pick.** Among the models you ticked, the cheapest whose Arena rating for that task is within the mode's margin of the best one: 80 points for Save more, 40 for Balanced, 15 for Best quality. With a speed chosen, the cheapest within that time, or the fastest, among the same models.
3. **Fallback.** If the pick is busy or unreachable before it answers, Auto passes the request to its next pick, at most twice, and says so.
4. **What it never picks:** a model you did not tick, a retired one, one without a rating, or one that cannot take the files you attached.

## Privacy

Leanfare reads usage numbers, never your words.

- **Your plans** takes the model, the time and the token counts from each line of Claude Code's and Codex's log files, and drops the rest of the line. **The status line** reads only the two percentages Claude Code hands it.
- **Find my keys** reads only the files named above, only when you press it; a key goes only to its own provider, to test it. **Your login shell's settings** are asked for key variables only (names ending in `_KEY`), and only by a Leanfare that did not start from a terminal.
- **Your chats in Leanfare** stay on your computer and go only to the AI company you pick. The cost ledger, the delegate's and the trial's records keep models, token counts, times and costs, never what you wrote.
- **No telemetry.** Leanfare talks to the AI companies you use; to llmledger's price list once a day; to models.dev's list of providers when you add a provider or look for keys (kept for a day); to OpenRouter when you use it; and to GitHub's list of releases once a day to see whether a new version is out (Settings can turn this off). Nothing else, and nothing about you or your use.

## Commands

| Command | Does | Exit code |
|---|---|---|
| `leanfare` | Starts and opens the app (`--port 4748`, `--no-open`) | 0 started or already running, 4 port taken, 1 failed |
| `leanfare status` | Says whether it runs, where, and how old its prices are | 0 running, 3 not running |
| `leanfare stop` | Stops it, letting running answers finish (at most 10 seconds) | 0 stopped |
| `leanfare apps` | The AI apps on this computer and whether Leanfare's tools are in each; `add <app>` and `remove <app>` | 0, 1 failed, 2 unknown app |
| `leanfare trial` | Runs the trial and prints its report; `--report` the last one again, `--share` opens it as a GitHub issue to read and send | 0 done, 1 no model ready, a failed run or Leanfare not answering, 130 stopped with Ctrl+C |
| `leanfare mcp` | The MCP server, over stdio | 0 when the client closes it |
| `leanfare statusline` | The line Claude Code shows at its bottom (`--then '<command>'` puts your own line first) | 0 |
| `leanfare --version` | Prints the version | 0 |

Everything lives in `~/.leanfare`: the database (settings, cost ledger, chats and their files), a daily backup kept for three days, and the last downloaded price list. Set `LEANFARE_DATA_DIR` to move it.

## Definitions

| Number | Definition |
|---|---|
| Cost | Uncached input tokens × input price + cached tokens × cache price + cache writes × cache write price + output tokens (thinking included) × output price, all ÷ 1,000,000. Long context prices apply past 200k input tokens when the data has them. Perplexity's own reported cost is used when it gives one (it includes its search fee). |
| Estimate | The same, with input counted from the text and the answer length taken from your own recent answers for that task, model and effort (or a default), labelled as an estimate. |
| Time | The median wait for the first words over a model's last 50 good answers here, plus the expected answer length divided by its median writing speed. Three answers are needed; before that, a rough guess by the model's kind. |
| Saved by Auto | For each answer where Auto picked a model other than your usual one: what the usual model would have cost for the same tokens, minus what the answer cost. |
| Budget reservation | Everything the request sends at one token per byte, plus its answer limit. While a budget is on, a request without a limit of its own is sent with one: 4,096 answer tokens, 8,192 for thinking models. |
| Worth of a plan | This month's tokens in the Claude Code or Codex log files, each at the API price of its model, added up. |
| Work left | What is left of a limit times how much work 1% holds, measured window by window from your own use (the 80th percentile of your windows, with a 90% range from 500 bootstrap draws); a starting estimate until three windows of your own. |
| Pass rate | Checked answers that passed, out of those that passed or failed, with Wilson's 90% range. |
| Trial pass | An effort passes when it gets at least 9 of the 10 trial questions right. |

## Data and credits

Prices, retirement dates and thinking levels come from [llmledger](https://github.com/pouriaetab/llmledger) (MIT), built daily from LiteLLM's public price list (MIT). Quality ratings come from the [Arena leaderboard](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (CC BY 4.0). Providers you add are priced from [models.dev](https://models.dev) (MIT). Key shapes for Paste any key follow the patterns of [gitleaks](https://github.com/gitleaks/gitleaks) and [betterleaks](https://github.com/betterleaks/betterleaks) (MIT). A copy of the price list ships with each release so Leanfare works offline; a fresh one is downloaded at start and once a day. The one-file builds have [Bun](https://bun.sh) inside (MIT; it links JavaScriptCore, which is LGPL-2), and Bun's licence file comes with every download. `bun scripts/licences.ts` checks that every source is still open for business use.

Leanfare is not affiliated with any AI provider.

## Known limits

- Estimates before sending are estimates: nobody knows an answer's length or a provider's speed in advance.
- The task guess is rules, not a trained model, so some tasks are guessed wrong. The reason is shown so you can spot it.
- Arena ratings measure what people prefer, not correctness. The trial measures your own setup on reading tasks only, not every kind of work.
- Prices are list prices; discounts and contracts are not known.
- Subscriptions without usage numbers on your computer (Perplexity, Google AI, Copilot, Cursor) show their limits, not your use.
- Your plans and what is left are estimates from the log files on this computer: work done elsewhere is not in them.
- The delegate reads text files only (no PDFs or images yet).
- Tools with Claude models work through `/v1/messages`, not through the OpenAI address. There is no `/v1/responses` address yet.
- The Windows build is new and less tested. The Mac app is built on your Mac from the code; a signed download comes later.

## Develop

```sh
bun install
bun test                     # against fake providers; nothing leaves your computer
bun scripts/smoke.ts         # starts the real command, uses it, stops it
bun scripts/preflight.ts     # versions, types, tests, licences, smoke
bun scripts/compile.ts       # the one-file builds, in dist/ (--check starts this computer's)
bun scripts/build-data.ts    # refresh the shipped price list from today's llmledger data
bash mac/build.sh            # build the Mac app (on a Mac)
```

TypeScript on Bun, with no runtime dependencies: Bun's own server, fetch and SQLite. The Mac app is one Swift file with AppKit and WebKit. Found a problem, or have trial results? Open an issue.

## Licence

MIT
