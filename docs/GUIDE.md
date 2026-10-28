# The Leanfare guide

Everything Leanfare does, for people who want the details. To start, the [README](../README.md) is enough: install it, open it, press **Turn on Leanfare**.

- [Set up and the switch](#set-up-and-the-switch)
- [What Leanfare does](#what-leanfare-does)
- [Install](#install)
- [Use it in your apps](#use-it-in-your-apps)
- [Plan a task](#plan-a-task)
- [Set up without typing](#set-up-without-typing)
- [Your subscriptions and pay per use](#your-subscriptions-and-pay-per-use)
- [Speed](#speed), [The chat](#the-chat), [Use it from your scripts](#use-it-from-your-scripts), [How Auto picks](#how-auto-picks)
- [Privacy](#privacy), [Commands](#commands), [Definitions](#definitions), [Data and credits](#data-and-credits), [Known limits](#known-limits), [Develop](#develop)

## Set up and the switch

- **Set up** comes the first time Leanfare opens (and again from Settings, In your apps, **Set up all at once**). It lists the AI apps on this computer and the models Leanfare can hand work to. **Turn on Leanfare** then does, for each app it found:
  - It adds Leanfare's tools (below), as **Add** in Settings, In your apps does. An app whose settings file Leanfare cannot read is left alone and said.
  - In Claude Code, Codex and Gemini CLI it also turns on **Plan by itself** (see [Plan a task](#plan-a-task)): a few lines that say when to hand work over, and in Claude Code a worker subagent and a prompt hook. When those cannot be written, the app still gets the tools, and the screen says why.
  - When no model you ticked can be used yet, it ticks the short list of each provider you have a key for, and every model of Ollama and the other model apps on this computer, as adding a key in Leanfare does.
  - With no model at all, it offers the quickest: Connect OpenRouter, Add a key, or Ollama for free models on this computer. With Ollama running but no model yet, it offers the free model that fits this computer (Settings, Local models).
  - While it runs, the button is its own Stop: Set up stops before the next app, and the list then shows which apps have Leanfare.
  - Then the page opens on Chat, with the one step each app needs at the top (most often a restart), until you press Done.
- **The switch** at the top of the page, **In your apps**, turns Leanfare off and on in your apps. Off, the tools that hand work over (`delegate`, `ask`, `plan`, `plan_run`, and starting the trial) answer that Leanfare is off, so your app does the work itself, and Claude Code's prompt hook says nothing. Plan parts that are running stop, and so does the trial. Work another program hands over while it is off is refused too: an app with an older copy's tools, a yes to paid parts that comes late, and `leanfare trial`. The other tools still answer, and Leanfare's own screens and your scripts still work. While it is off, a line at the top says so, with **Turn on**. It is a file named `off` in Leanfare's folder, so every app knows at once.
- **Day, Auto and Night**, the three buttons at the top right, set the colors (on a phone, the one in use shows, and a tap moves it on). Auto is day from 7 AM to 7 PM by this computer's clock. The choice is kept in this browser.

## What Leanfare does

Every top AI model in one app on your own computer, and on top of the AI apps you already use. Leanfare shows what each answer costs and how long it takes, picks the cheapest model that does the job well, keeps a monthly budget, and lets Claude hand reading work to cheaper models without losing quality.

- **Inside the apps you already use.** One press adds Leanfare's tools to Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code and LM Studio. You keep using them as usual; Leanfare works underneath.
- **Set up without typing.** Paste any API key and Leanfare knows whose it is. Keys in your environment (`OPENAI_API_KEY` and the like) are used as they are, and Find my keys offers the ones in other AI tools' files (llm, aider, Gemini CLI, Codex CLI, OpenCode, Continue), each used only after you tick it. Model apps running on your computer (Ollama, LM Studio, Jan, llama.cpp, vLLM, LocalAI, KoboldCpp, GPT4All, Lemonade) are found on their own.
- **Every top model, your own keys.** OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Perplexity, Groq, Cerebras, Together AI, Fireworks, OpenRouter (one key, many makers), local models, and any other provider that speaks OpenAI's format. No account, no markup, no middleman: requests go from your computer to the provider.
- **Subscriptions apart from pay per use.** Your Claude, ChatGPT, Perplexity, Google AI, Grok, Copilot and Cursor plans in tokens and limits: what you used, and what is left of the 5 hour, weekly or monthly limits where your computer keeps the numbers. The AI apps on this computer are found, and each plan counts only in its own months. What your keys and credits spent is shown on its own.
- **The cost and the time of every answer.** An estimate before you send, with its time, and the exact cost after. At the same quality, choose the cheapest, the cheapest within a time, or the fastest.
- **Automatic model choice.** Leanfare guesses the task (coding, math, writing, long documents and more) and picks the cheapest model you ticked that rates well for it. Every answer says which model wrote it and why.
- **Claude hands work to cheaper models.** Through the `delegate` tool, Claude passes reading heavy work to the cheapest model that is good enough, and a stronger model checks a sample of the answers. **The trial** measures how well that goes on your own models before you rely on it.
- **Plan a task across models.** Write what you want done, and Leanfare splits it into parts with the model for each: what changes your project or needs the hardest judgement stays with the app you work in, on your plan; reading and drafting go to local, free or cheap models, or to your ChatGPT plan through Codex, at once where they can. Claude Desktop and Cowork show the plan as a table in the chat, and Claude Code, Codex and Gemini CLI can plan on their own.
- **Models graded by how they did for you.** The app you work in grades each answer of Leanfare's it used: good, partly or wrong. A model graded below good too often for a kind of work is moved down, so the picks get better as you use them. Only the grade is kept, never the words.
- **A free model that fits your computer.** Leanfare suggests the best rated open model (Apache 2.0) that runs in your computer's memory and fits on its disk, and has Ollama download it when you say yes. Auto and plans use models on your computer at the rating of the same model in the cloud, a little lower.
- **A budget that holds.** Each request reserves the most it can cost before it goes out. A warning at 80%; at 100%, keep going on the cheapest model or stop.
- **A chat that does the everyday things.** Short answers by default. Attach images, PDFs and text files. Edit a question, ask again, or ask another model and see both costs. Per chat instructions, readable thinking, search, export, and import from ChatGPT or Claude.
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
| Local models | Install [Ollama](https://ollama.com/download): Settings, Local models, then suggests the best open model for this computer and downloads it when you say yes. Or load a model in [LM Studio](https://lmstudio.ai) and start its local server. Leanfare finds them on its own. |
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
- **plan** splits a task into parts, each with where it runs and its model, as a table (see [Plan a task](#plan-a-task)).
- **plan_run**, **plan_status** and **plan_stop** run Leanfare's parts of a plan in the background, give their answers, and stop them.
- **grade** says how good the answer of a plan's part or of `delegate` was: good, partly or wrong (see [Grades](#grades)).
- **local_model** suggests the best open model for this computer, has Ollama download it after the user's yes, and says how the download goes.

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

## Plan a task

Write what you want done in the **Plan** tab, or let Claude call the `plan` tool. Leanfare splits it into parts (reading, drafting, working something out, changing code, searching) and puts each where it costs least without losing quality:

| # | Part | Kind | Runs on | Model | Time | Tokens | Cost | When |
|---|---|---|---|---|---|---|---|---|
| 1 | Map the code: its parts and how they fit | read, low | Leanfare, free model | Gemini 3.8 Flash | ~8 s | ~41k kept | $0 | now |
| 2 | Read the parts that matter closely | read, medium | Leanfare, pay per use | DeepSeek V4 Flash | ~12 s | ~43k kept | $0.01 | after 1 |
| 3 | Decide the design and the steps | reason, high | you (Claude Code) | Claude Opus 5.5 | | ~9k of your plan | in your plan | after 2 |
| 4 | Make the changes and run the tests | code, high | you (Claude Code) | Claude Opus 5.5 | | ~12k of your plan | in your plan | after 3 |
| 5 | Review the changes | reason, medium | Leanfare, pay per use | DeepSeek V4 Flash | ~10 s | ~14k kept | under $0.01 | after 4 |

- **What stays with you.** Changes to your project, anything that needs your app's own tools, and high effort judgement stay with the app you work in. Reading, drafting and working things out go to the cheapest model you ticked that rates well enough, local and free ones first. When your plan is near a limit (85% of the 5 hours or the week), the hard parts go out too.
- **The model for each part.** A part Leanfare runs names Leanfare's pick. A part that stays with you names the model to pick in your app, by the same rule: the cheapest of your app's models rated well enough for it, since a dearer model uses more of your plan. In Claude Code, as the ratings stand: Opus 5.5 for the hardest judgement and code, Sonnet 5.5 for most work, Haiku 5.5 for light work; Claude Code runs a part on another model with a subagent. The Plan tab asks which app you work in (Claude Code, Claude Desktop or Cowork, Codex, Gemini CLI, Cursor).
- **Who splits it.** A model you ticked (a few cents or less, $0 on free models), or rules: tick **Split by rules**. A model that takes more than 40 seconds is let go, and the rules split it, so an app that waits about a minute for an answer still gets its plan.
- **Running it.** Parts that do not wait for each other run at once, and each part gets the answers of the parts it needs. In the Plan tab, press **Run Leanfare's parts**. In your app, Claude runs them with `delegate`, with Claude Code's `leanfare-worker` subagent (one per part, at once), or in the background with `plan_run`, then `plan_status` for the answers. The answers are also saved in the project, in `.leanfare/plans/<id>/`, a folder git ignores, where you and every app can read them. A part that waits for one of yours is yours to hand over once yours is done.
- **Files.** Name files or folders and Leanfare measures them. Files that hold secrets are never read, and a folder's dotfiles and links are left out. One hand off takes at most 50 files and 4 MB; past that, the files whose names hold the task's words go first, and the table says how many go.
- **Paid parts.** Parts on local and free models run on their own, and so do their checks. Paid parts run only with your yes: **Run** in the Plan tab or on the plan's page in the chat, or a question in apps that can ask (Claude Code). Settings can let a plan's paid parts run without asking up to an amount. Your monthly budget holds either way.
- **Your ChatGPT plan, through Codex.** Turn it on in Settings, Your ChatGPT plan through Codex. Reading, drafting and working out parts then run on Codex (`codex exec`) before any pay per use model: read only, in the folder of their files, without your MCP servers, apps or plugins (they act outside its sandbox), two at a time, each for at most 15 minutes. They count toward your ChatGPT plan's Codex limits, and Leanfare pays nothing for them. Only when Codex is signed in with ChatGPT (an API key would be billed per use), not when you work in Codex itself (those parts are yours already), and not while your ChatGPT plan is at 85% of its 5 hours or its week, checked again when each part runs. Codex decides what it reads there, as when you use it.
- **A local model.** When a part would be paid, or no model you ticked can take it, and a free open model fits this computer, the plan says which. Settings, Local models (or the `local_model` tool) downloads it on a yes.
- **In the chat.** Claude Desktop and Cowork show the plan as a page in the chat (an MCP App): the table, Run and Stop, the answers as they come, and a button that hands them back to Claude.
- **Plan by itself.** In Settings, In your apps, **Plan by itself** adds a few lines to Claude Code's `CLAUDE.md`, Codex's `AGENTS.md` or Gemini CLI's `GEMINI.md`, so the app calls the plan for a task with several parts. In Claude Code it also adds the `leanfare-worker` subagent (on Haiku) and a prompt hook that says how much of your plan is left. Leanfare changes only its own lines, and **Turn off** takes them out.

### Grades

Once the app you work in has used the answer of a part Leanfare ran, or of `delegate`, it grades it with the `grade` tool: good (used as it was), partly (fixed or redone in part) or wrong (not used). In the Plan tab you can grade too, under each answer. The grade goes with the model that answered and the kind of work: reading, drafting, working things out or searching.

A model graded below good too often for a kind (at least 3 of its last 20 grades, under half good, partly counting half) is moved down: plans and the delegate skip it for that kind while another model can take it. Settings, How the models did for you, lists the grades of each model and gives one that was moved down another chance. Leanfare keeps only the model, the kind, the effort, the grade, who gave it and when, and only each model's last 20 grades for a kind.

## Set up without typing

- **Paste any key.** One box in Settings takes a key from any provider: Leanfare tells by its shape whose it is (patterns from gitleaks), tests it with that provider and saves it. A key it cannot place offers to add its provider.
- **Keys in your environment** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GROQ_API_KEY` and the like) are used without pasting. A Leanfare that did not start from a terminal (the Mac app, or an app starting it for its tools) asks your login shell for the ones its settings export, and keeps only variables whose names end in `_KEY`. Settings shows where each key came from; one from your environment or your shell's settings is removed there, not in Leanfare.
- **Find my keys** looks in your environment and your login shell's, and in the key files of llm, aider, Gemini CLI, Codex CLI (only an API key login), OpenCode (only API keys) and Continue. You see each key's last four characters and where it was; tick the ones to use. A key for a provider Leanfare does not have yet (from models.dev's list, by its `*_API_KEY` name) is offered unticked, with the address it would go to. Subscription logins (Claude's, ChatGPT's, Gemini CLI's) and general tokens (`GITHUB_TOKEN` and the like) are never used.
- **Model apps on this computer** are found by asking the usual local addresses which models they serve.
- **Add a provider.** Any service that speaks OpenAI's format: pick it from the list of known providers (from models.dev, with its address and prices) or type its name and address.

## Your subscriptions and pay per use

Savings shows two things apart:

- **Your subscriptions.** Pick your plans in Settings (Claude Pro or Max, ChatGPT Go, Plus, Pro or Business, Perplexity Pro or Max, Google AI Plus, Pro or Ultra, Grok, Copilot Pro or Pro+, Cursor Pro or Ultra; the price can be edited), with the month each started and, for one you ended, the month it ended. Each shows its limits: a 5 hour window and a week for Claude and Codex, weekly or monthly allowances for the others. Savings shows a plan only in its months, and names the AI apps it found on this computer (from when each came and when it was last used).
  - **Claude:** this month's Claude Code tokens, and what is left of the 5 hours and the week, from Claude Code's status line (**Add to the status line** on the Savings page). Settings can also show what that use would cost at API prices.
  - **ChatGPT:** the same from Codex's own log files, which also name your plan, so Leanfare offers it.
  - **Perplexity, Google AI, Copilot and Cursor** keep no usage numbers on your computer: Leanfare shows their limits, and a link to their own usage page where they have one.
- **Pay per use: what your keys and credits spent through Leanfare.** The spend, what Auto saved, the budget, and each answer's cost.

**What is left** is shown in tokens at your recent mix (and in dollars of work at API prices, when Settings shows them), with a 90% range, and **what still fits** says how many typical sessions of each project fit before the limit. Anthropic's terms do not let other apps use a Claude Pro or Max login, so Leanfare only counts: it never sends a request on your plan.

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
- **A plan** goes to the model that splits it (or to none, by rules), and each part goes only to the model the table names for it. The answers are saved in your project's `.leanfare` folder, nowhere else.
- **A part on Codex** goes to OpenAI through your own Codex command, as any Codex task does, and Codex reads what it needs, as when you use it. Leanfare asks Codex only how it is signed in, and never reads its sign in.
- **Grades** keep the model, the kind of work and the grade, never the question or the answer.
- **A local model** is downloaded by Ollama, from its library, only after your yes.
- **The apps on this computer** are found by dates only: Spotlight's, and the times of their own folders and files (when each came and when it was last used). No file of theirs is opened.
- **No telemetry.** Leanfare talks to the AI companies you use; to llmledger's price list once a day; to models.dev's list of providers when you add a provider or look for keys (kept for a day); to OpenRouter when you use it; and to GitHub's list of releases once a day to see whether a new version is out (Settings can turn this off). Nothing else, and nothing about you or your use.

## Commands

| Command | Does | Exit code |
|---|---|---|
| `leanfare` | Starts and opens the app (`--port 4748`, `--no-open`) | 0 started or already running, 4 port taken, 1 failed |
| `leanfare status` | Says whether it runs, where, and how old its prices are | 0 running, 3 not running |
| `leanfare stop` | Stops it, letting running answers finish (at most 10 seconds) | 0 stopped |
| `leanfare apps` | The AI apps on this computer and whether Leanfare's tools are in each; `add <app>` and `remove <app>` | 0, 1 failed, 2 unknown app |
| `leanfare trial` | Runs the trial and prints its report; `--report` the last one again, `--share` opens it as a GitHub issue to read and send | 0 done, 1 no model ready, Leanfare switched off, a failed run or Leanfare not answering, 130 stopped with Ctrl+C |
| `leanfare mcp` | The MCP server, over stdio | 0 when the client closes it |
| `leanfare statusline` | The line Claude Code shows at its bottom (`--then '<command>'` puts your own line first) | 0 |
| `leanfare hook prompt` | The prompt hook Plan by itself adds to Claude Code: a line on how much of your plan is left (nothing while Leanfare is off) | 0, always |
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
| Grade score | A model's grades for one kind of work, good 1, partly 0.5, wrong 0, averaged over its last 20. Under 0.5, from 3 grades on, it is moved down. |
| Local rating | A model on your computer takes the Arena rating of the same model in the cloud (the same family and size), 15 points lower for the lighter copy. |

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
- A plan's parts run on models you have keys or local apps for, and on your ChatGPT plan through Codex when you turn that on. Your Gemini or Claude subscription is not used for Leanfare's parts; the parts that stay with you use your own app's plan.
- Grades come from the app you work in (or from you, in the Plan tab). An app that does not grade leaves every model as it is.
- Models on your computer get at most 16k tokens of context, so Auto sends them only prompts that fit, and no request with tools or a response format (Ollama runs those at 4,096 tokens). A model Leanfare cannot match to a rated model in the cloud is not picked by Auto: choose it by name.
- Tools with Claude models work through `/v1/messages`, not through the OpenAI address. There is no `/v1/responses` address yet.
- The switch at the top is for Leanfare's tools in your apps. Scripts that call Leanfare's address themselves ([Use it from your scripts](#use-it-from-your-scripts)) still work while it is off.
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

MIT, see [LICENSE](../LICENSE).
