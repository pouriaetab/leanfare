# Leanfare

Every top AI model in one app on your own computer. Leanfare shows what each answer costs, picks the cheapest model that does the job well, keeps a monthly budget, and tells you how much you saved.

- **Every top model, your own keys.** OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, OpenRouter (one key, many makers) and local models through Ollama. No account, no markup, no middleman: requests go from your computer to the provider.
- **The cost of every answer.** An estimate before you send, the exact cost after, cached tokens at their own price, and the source of every price one tap away.
- **Automatic model choice.** Leanfare guesses the task (coding, math, writing, long documents and more) and picks the cheapest model you ticked that rates well for it. Every answer says which model wrote it and why.
- **A budget that holds.** Each request reserves the most it can cost before it goes out, so requests sent at the same moment cannot pass the budget together. A warning at 80%; at 100%, keep going on the cheapest model or stop.
- **A chat that does the everyday things.** Attach images, PDFs and text files. Edit a question, ask again, or ask another model and see both costs side by side. Per chat instructions, readable thinking, search across chats, export, and import from ChatGPT or Claude.
- **Free local models.** Download, run and remove models with Ollama from Settings, with a check that each one fits your memory and disk.
- **What your plans are worth, and what is left.** What your Claude Code and Codex use would cost at API prices, next to what you pay; what is left of each plan's 5 hour and weekly limits, in dollars of work and tokens; and which of your projects still fits before the limit.
- **Claude can hand work to cheaper models.** Through the MCP server's `delegate` tool, Claude passes reading heavy work to the cheapest model that is good enough, and a stronger model checks a sample of the answers.
- **A Mac app.** Today's spend in the menu bar, the chat in a window, a note pad for ideas.
- **The same engine for your other tools.** An OpenAI-compatible address and Anthropic's `/v1/messages`, so scripts and apps land in the same totals and the same budget. An MCP server for Claude Code, Claude Desktop and other MCP clients.
- **Light and private.** One process of about 60 MB, one SQLite file, no telemetry, no runtime dependencies. Keys stay in the macOS Keychain. Leanfare reads usage numbers, never your words (see [Privacy](#privacy)).

## Start

You need [Bun](https://bun.sh) 1.4.

```sh
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/pouriaetab/leanfare.git
cd leanfare
bun src/cli.ts
```

The app opens in your browser at `http://127.0.0.1:4747`. Run `bun link` once to have the `leanfare` command everywhere.

**The Mac app.** With Apple's Command Line Tools installed (`xcode-select --install`), build it from the same folder:

```sh
bash mac/build.sh --install
```

It goes to your Applications folder and opens: today's spend is in the menu bar, and Open Leanfare shows the chat. It starts Leanfare by itself, with the Bun the build found, and stops it when you quit. A Leanfare you started in Terminal is used as it is and left running.

Paste one key, or start free:

| Free way to start | How |
|---|---|
| Google Gemini | Make a free key at [Google AI Studio](https://aistudio.google.com/apikey) and paste it. On Google's free plan, Google may use your messages to improve its products. Tick "free plan" so its answers count as $0. |
| Ollama | Install [Ollama](https://ollama.com/download) and pull a model (`ollama pull llama3.2`). Leanfare finds it on its own. |
| OpenRouter | Press **Connect OpenRouter** and sign in on OpenRouter's page: Leanfare gets a key with nothing to copy. Or make a key at [openrouter.ai](https://openrouter.ai/settings/keys) and paste it. Models whose name ends in `:free` cost nothing. |

Keys already in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`) are picked up without pasting.

## The chat

- **Files.** Drop, paste or attach images (PNG, JPEG, WebP, GIF, HEIC), PDFs and text or code files. Text files go into the message, so every model reads them. Images go to models that see images, PDFs to Claude, GPT and OpenRouter models that read them; Auto picks among those. Big photos are made smaller first. A file counts in the estimate and the budget by its tokens, not its size.
- **Edit, again, another model.** Change any question and send it again, ask the same question again, or ask another model and keep both answers, with how many times cheaper or dearer the new one was.
- **Instructions.** Each chat can have its own instructions (a system prompt); new chats start with yours from Settings.
- **Thinking.** What a thinking model thinks is shown folded above its answer. Set the effort (low, medium, high) for the models that take it; the estimate learns what each level costs you.
- **Second tries.** An answer that comes back empty, or is cut off on the way, is asked for once more, and the answer says so.
- **Your chats.** Search them, export one as Markdown or all as one file, and import your history from ChatGPT or Claude (the .zip they email you). History can be turned off; the cost ledger never keeps what you wrote.

## Local models

Settings, Local models, lists what Ollama has on this computer and what is loaded now.

- **Download** a model by its Ollama name (`gemma3:12b`) or straight from Hugging Face (`hf.co/user/repo:Q4_K_M`), with a progress bar and its own Stop. A download that stops can be continued.
- Before it starts, Leanfare says whether the model **fits** this computer's memory, is **tight**, or is **too big**, and it never fills the disk: 10 GB always stay free.
- **Remove** asks first and says how much it frees.
- No Ollama yet: one line with its download link.

## Your plans and what is left

Enter what you pay for Claude and ChatGPT in Settings, and the Savings page shows what your plans are worth.

- **Worth.** This month's Claude Code and Codex use, read from the log files those two programs keep on this computer, at the API prices of the same tokens, next to your plan's price.
- **What is left.** Each plan's two limits, the 5 hours and the week, as bars with the percent used and when they reset. Under each: about how much work is left, in dollars at API prices and in tokens at your recent mix, with a 90% range.
- **What still fits.** For each project you work on with Claude Code: about how many of your typical sessions still fit before the limit, so at 90% of the week you know which project you can still finish.
- **Claude's percentages** come from Claude Code's status line. Press **Add to the status line** on the Savings page and Claude Code shows `5h 42% · week 90% · about 2 webshop sessions left` at its bottom; a status line you already had stays first. **ChatGPT's** come from Codex's own log lines.
- **How the estimate works.** Leanfare compares the work in the logs (at API prices) with how far the percentages moved, window by window, and takes how much work 1% holds from that, with a bootstrap for the range. Until it has three windows of your own, it starts from what others measured for each plan, and says so. Percent that moves with no work in the logs is shown as use the logs do not show (Claude's chats, Cowork, the phone apps): it counts toward the same limits.

Anthropic's terms do not let other apps use a Claude Pro or Max login, so Leanfare only counts: it never sends a request on your plan.

## Use it from your other apps

Point anything that speaks OpenAI's or Anthropic's format at Leanfare. Leanfare uses the keys you saved in it.

```sh
curl http://127.0.0.1:4747/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4747/v1", api_key="leanfare")
reply = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
```

```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:4747", api_key="leanfare")
reply = client.messages.create(model="claude-sonnet-5-5", max_tokens=500, messages=[{"role": "user", "content": "Hello"}])
```

- **Model names:** `auto`, `auto-save`, `auto-balanced`, `auto-best`, or a model id such as `google/gemini-3.8-flash`, `claude-sonnet-5-5` or `openrouter/anthropic/claude-haiku-5.5`. `GET /v1/models` lists the ones you ticked.
- **Every answer carries headers:** `x-leanfare-model`, `x-leanfare-cost-usd`, `x-leanfare-estimate-usd`, `x-leanfare-task` and `x-leanfare-reason`. A streamed answer ends with a comment line holding its cost.
- **Mode per request:** send `x-leanfare-mode: save`, `balanced` or `best`. **Thinking:** `reasoning_effort` works for Claude models on the OpenAI address too.
- **An access key.** By default any app on your computer can use these addresses with any key. Turn on "Other apps need a key" in Settings and they need Leanfare's key (`lf-...`) as their API key. A browser asks for the key once, and again after you make a new key; the Mac app and the `leanfare` command open Leanfare without it.
- **Web pages** on other sites are refused unless you allow their address in Settings.

### Claude Code, Claude Desktop and other MCP clients

`leanfare mcp` is an MCP server over stdio with five tools: **delegate** (hand a task and its files to a cheaper model, below), **ask** (a question through Leanfare, with its cost), **spend** (today, this month, the budget, what Auto saved), **models** (what you ticked, with prices) and **estimate** (a prompt's cost before sending). It starts Leanfare if it is not running.

Claude Code, for every project:

```sh
claude mcp add --scope user leanfare -- /Users/you/.bun/bin/bun /Users/you/leanfare/src/cli.ts mcp
```

Claude Desktop's settings file (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "leanfare": { "command": "/Users/you/.bun/bin/bun", "args": ["/Users/you/leanfare/src/cli.ts", "mcp"] }
  }
}
```

It speaks the 2026-07-28 protocol and the earlier ones.

### Hand work to cheaper models (delegate)

Claude stays in charge and hands pieces of work to Leanfare: searching or summarizing big files, logs or many documents, reviewing a file, drafting a section. Leanfare reads the files itself, so their text never enters Claude's context, picks the cheapest model you ticked that rates well enough, and answers briefly with a receipt:

```
(Leanfare delegate: DeepSeek V4 Flash, $0.0004. Checked by Gemini 3.8 Flash: passed ($0.0011). About 54,000 tokens of files stayed out of your context; this answer is about 300.)
```

- **Effort.** `low` takes the cheapest model rated within 80 points of the best you ticked (Save more), `medium` within 40 (Balanced), `high` within 15 (Best quality). It is also the thinking effort for models that think.
- **Kind.** `read` (find, pull out, summarize), `write` (draft text or code) or `reason` (work something out) decides which Arena rating counts: long prompts, detailed instructions or coding, hard prompts or math.
- **Checks.** A model rated above the one that answered checks every high effort answer, 1 in 4 medium ones and 1 in 10 low ones, and says pass or fail. A failed answer is asked again one tier up, with the checker's reason. Neither a check nor a second try goes past your budget.
- **Files.** Text files only: at most 50, 2 MB each, 4 MB in all. Files that hold secrets are never read: `.env` files and their kin (`.envrc`, `production.env`), private keys and certificates, credential and token files (Claude Code's and Codex's own sign ins among them), and anything in `.ssh`, `.gnupg`, `.aws`, `.git`, a keychain or Leanfare's own folder. Names are compared without regard to case.
- **Savings** shows what was handed over, what it cost, how many tokens of files stayed out of Claude's context, and how the checks went: the pass rate with a 90% range, and the rate weighted back to every task (each checked answer counts once for every answer it stands for).

To have Claude use it on its own, add a line to your project's `CLAUDE.md`, for example: "To read large files or logs, use Leanfare's delegate tool and work from its answer."

## How Auto picks

1. **Task guess.** Rules read the conversation: code blocks or programming words give *coding*; equations give *math*; "write a story" gives *creative writing*; a long paste or a PDF gives *long prompts*; past five questions gives *long conversations*; business, legal and health words give those tasks; otherwise *everyday questions*. The guess and its reason are shown on every answer.
2. **Best value pick.** Among the models you ticked, the cheapest whose Arena rating for that task is within the mode's margin of the best one: 80 points for Save more, 40 for Balanced, 15 for Best quality. A new model without a rating yet borrows the rating of its family's previous version, and says so.
3. **Fallback.** If the pick is busy or unreachable before it starts answering, Auto passes the request to its next pick, at most twice, and says so.
4. **What it never picks:** a model you did not tick, a retired one, one without a rating (local models are used when you choose them), or one that cannot take the files you attached.

## Privacy

Leanfare reads usage numbers, never your words.

- **Your plans** takes the model, the time and the token counts from each line of Claude Code's and Codex's log files, and drops the rest of the line.
- **The status line** reads only the two percentages in what Claude Code hands it, and the name of the folder it runs in. Leanfare keeps the percentages and when they changed; nothing else.
- **Other apps' chats** are never read: Claude, ChatGPT, Gemini, Grok and the rest keep no usage numbers on your computer, and Leanfare does not sign in to them.
- **Your chats in Leanfare** stay on your computer and go only to the AI company you pick. The cost ledger and the delegate's records keep models, token counts and costs, never what you wrote.
- **The delegate** reads only the files it is handed, never files that hold secrets, and sends them only to the model it picks.
- **No telemetry.** Leanfare talks to the AI companies you use, to llmledger's price list, and to OpenRouter when you use it. Nothing else.

## Definitions

| Number | Definition |
|---|---|
| Cost | Uncached input tokens × input price + cached tokens × cache price + cache writes × cache write price + output tokens (thinking included) × output price, all ÷ 1,000,000. Claude's cache writes kept an hour cost twice the input price unless listed otherwise. A request of more than 200k input tokens is priced at the model's long context prices, when the data has them. |
| Estimate | The same, with input counted from the text (images and PDF pages at typical token counts) and the answer length taken from your own recent answers for that task, model and effort (or a default), labelled as an estimate. |
| Saved by Auto | For each answer where Auto picked a model other than your usual one: what the usual model would have cost for the same tokens, minus what the answer cost. |
| More for your money | What all of this month's answers would have cost on your usual model, divided by what they did cost. |
| Gap to a subscription | The price you entered minus what you spent this month. |
| Budget reservation | Everything the request sends (messages, system prompt, tools) at one token per byte, with images and PDF pages at their high token counts, plus its answer limit. While a budget is on, a request without a limit of its own is sent with one: 4,096 answer tokens, 8,192 for thinking models. |
| Worth of a plan | This month's tokens in the Claude Code or Codex log files, each at the API price of its model, added up. An estimate: the logs do not show the plan's own limits. |
| Work left | What is left of a limit (100% minus the percent used) times how much work 1% holds. How much 1% holds: for each finished window, the work in the logs divided by how far the percent moved; Leanfare takes the 80th percentile of your windows (so use the logs miss does not make it too low), with a 90% range from 500 bootstrap draws. Tokens left are the work left at the price of your recent mix of models and token types. |
| What still fits | Work left divided by a project's typical session: the median of its last 10 sessions, at API prices. |
| Pass rate | Checked answers that passed, out of those that passed or failed, with Wilson's 90% range. The weighted rate counts each checked answer once for every answer it stands for (one over its chance of being checked). |

## Commands

| Command | Does | Exit code |
|---|---|---|
| `leanfare` | Starts and opens the app (`--port 4748`, `--no-open`) | 0 started or already running, 4 port taken, 1 failed |
| `leanfare status` | Says whether it runs, where, and how old its prices are | 0 running, 3 not running |
| `leanfare stop` | Stops it, letting running answers finish (at most 10 seconds) | 0 stopped |
| `leanfare mcp` | The MCP server, over stdio | 0 when the client closes it |
| `leanfare statusline` | The line Claude Code shows at its bottom (Add to the status line sets it up; `--then '<command>'` puts your own line first) | 0 |
| `leanfare --version` | Prints the version | 0 |

Everything lives in `~/.leanfare`: the database (settings, cost ledger, chats and their files), a daily backup kept for three days, and the last downloaded price list. Set `LEANFARE_DATA_DIR` to move it.

## Data and credits

Prices, retirement dates and thinking levels come from [llmledger](https://github.com/pouriaetab/llmledger) (MIT), built daily from LiteLLM's public price list (MIT). Quality ratings come from the [Arena leaderboard](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (CC BY 4.0), condensed to each model's best rating per task. A copy ships with each release so Leanfare works offline; a fresh one is downloaded at start and once a day. OpenRouter prices come from OpenRouter's own model list, read on your computer. `bun scripts/licences.ts` checks that every source is still open for business use.

Leanfare is not affiliated with any AI provider.

## Known limits

- Estimates before sending are estimates: nobody knows an answer's length in advance.
- The task guess is rules, not a trained model, so some tasks are guessed wrong. The reason is shown so you can spot it.
- Arena ratings measure what people prefer, not correctness.
- Prices are list prices; discounts and contracts are not known. Long context prices apply once llmledger's data carries them.
- The successor rule can be wrong; it is shown 30 days ahead and can be changed.
- While a budget is on, an answer without a limit of its own stops at 4,096 tokens (8,192 for thinking models), and the chat says so.
- Gemini reads images through Leanfare but not PDFs yet; Claude and GPT models do.
- Your plans and what is left are estimates from the log files on this computer: work done on another computer, or in the apps' own chat windows, is not in them. How much 1% holds needs three windows of your own before it stops being a starting estimate, and Max 5x has no measured starting point yet.
- The delegate reads text files only (no PDFs or images yet), and its checks pick the checker by Arena ratings, not yet by your own results.
- Tools with Claude models work through `/v1/messages`, not through the OpenAI address. There is no `/v1/responses` address yet.
- The Mac app is built on your Mac from source; a signed download comes later.

## Develop

```sh
bun install
bun test                     # against fake providers; nothing leaves your computer
bun scripts/smoke.ts         # starts the real command, uses it, stops it
bun scripts/preflight.ts     # versions, types, tests, licences, smoke
bun scripts/build-data.ts    # refresh the shipped catalogue from today's llmledger data
bash mac/build.sh            # build the Mac app (on a Mac)
```

TypeScript on Bun, with no runtime dependencies: Bun's own server, fetch and SQLite. The Mac app is one Swift file with AppKit and WebKit.

## Licence

MIT
