# Leanfare

Every top AI model in one app on your own computer. Leanfare shows what each answer costs, picks the cheapest model that does the job well, keeps a monthly budget, and tells you how much you saved.

- **One command.** `leanfare` opens the app at `http://127.0.0.1:4747`. No account, no server, no Docker.
- **Every top model.** OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, OpenRouter (one key, many makers) and local models through Ollama. Each provider shows a short list: the best price for each level of quality. Tick the ones you want.
- **The cost of every answer.** An estimate before you send, the exact cost after, cached tokens at their own price, and the source of every price one tap away.
- **Automatic model choice.** Leanfare guesses the task (coding, math, writing, long prompts and more) and picks the cheapest model you ticked that rates well for it, in one of three modes: Save more, Balanced, Best quality. Every answer says which model wrote it and why.
- **A budget that holds.** Each request reserves the most it can cost before it goes out, so requests sent at the same moment cannot pass the budget together. A warning at 80%; at 100%, keep going on the cheapest model or stop.
- **Retirement warnings.** A notice 30 days before a model you use retires, and an automatic switch to its successor on the day.
- **A savings page.** What you spent, what Auto saved against your usual model, how many more answers your money bought, and the gap to a subscription price you enter.
- **The same engine for your other apps.** An OpenAI-compatible address (`/v1/chat/completions`, streaming included) and Anthropic's `/v1/messages`, so scripts and tools land in the same totals.
- **Private by design.** No telemetry. Keys stay in the macOS Keychain (elsewhere, in a file only you can read). Chats stay on your computer, and history can be turned off. The cost ledger keeps token counts and costs, never what you wrote.

## Start

You need [Bun](https://bun.sh) 1.4.

```sh
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/pouriaetab/leanfare.git
cd leanfare
bun src/cli.ts
```

The app opens in your browser at `http://127.0.0.1:4747`. Run `bun link` once to have the `leanfare` command everywhere.

Paste one key, or start free:

| Free way to start | How |
|---|---|
| Google Gemini | Make a free key at [Google AI Studio](https://aistudio.google.com/apikey) and paste it. On Google's free plan, Google may use your messages to improve its products. Tick "free plan" so its answers count as $0. |
| Ollama | Install [Ollama](https://ollama.com/download) and pull a model (`ollama pull llama3.2`). Leanfare finds it on its own. |
| OpenRouter | Make a key at [openrouter.ai](https://openrouter.ai/settings/keys). Models whose name ends in `:free` cost nothing. |

Keys already in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`) are picked up without pasting.

## Use it from your other apps

Point anything that speaks OpenAI's or Anthropic's format at Leanfare. Any API key works; Leanfare uses the keys you saved in it.

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
- **Mode per request:** send `x-leanfare-mode: save`, `balanced` or `best`.
- **Web pages** on other sites are refused unless you allow their address in Settings.

## How Auto picks

1. **Task guess.** Rules read the conversation: code blocks or programming words give *coding*; equations give *math*; "write a story" gives *creative writing*; a long paste gives *long prompts*; past five questions gives *long conversations*; business, legal and health words give those tasks; otherwise *everyday questions*. The guess and its reason are shown on every answer.
2. **Best value pick.** Among the models you ticked, the cheapest whose Arena rating for that task is within the mode's margin of the best one: 80 points for Save more, 40 for Balanced, 15 for Best quality. A new model without a rating yet borrows the rating of its family's previous version, and says so.
3. **Fallback.** If the pick is busy or unreachable before it starts answering, Auto passes the request to its next pick, at most twice, and says so.
4. **What it never picks:** a model you did not tick, a retired one, or one without a rating (local models are used when you choose them). On the OpenAI address, a request with tools goes to a model that takes tools there.

## Definitions

| Number | Definition |
|---|---|
| Cost | Uncached input tokens × input price + cached tokens × cache price + cache writes × cache write price + output tokens × output price, all ÷ 1,000,000. List prices in US dollars per 1M tokens. |
| Estimate | The same, with input counted from the text and the answer length taken from your own recent answers for that task (or a default), labelled as an estimate. |
| Saved by Auto | For each answer where Auto picked a model other than your usual one: what the usual model would have cost for the same tokens, minus what the answer cost. |
| More for your money | What all of this month's answers would have cost on your usual model, divided by what they did cost. |
| Gap to a subscription | The price you entered minus what you spent this month. |
| Budget reservation | Everything the request sends (messages, system prompt, tools) at one token per byte, plus its answer limit. While a budget is on, a request without a limit of its own is sent with one: 4,096 answer tokens, 8,192 for thinking models. |

## Commands

| Command | Does | Exit code |
|---|---|---|
| `leanfare` | Starts and opens the app (`--port 4748`, `--no-open`) | 0 started or already running, 4 port taken, 1 failed |
| `leanfare status` | Says whether it runs, where, and how old its prices are | 0 running, 3 not running |
| `leanfare stop` | Stops it, letting running answers finish (at most 10 seconds) | 0 stopped |
| `leanfare --version` | Prints the version | 0 |

Everything lives in `~/.leanfare`: the database (settings, cost ledger, chats), a daily backup kept for three days, and the last downloaded price list. Set `LEANFARE_DATA_DIR` to move it.

## Data and credits

Prices and retirement dates come from [llmledger](https://github.com/pouriaetab/llmledger) (MIT), built daily from LiteLLM's public price list (MIT). Quality ratings come from the [Arena leaderboard](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (CC BY 4.0), condensed to each model's best rating per task. A copy ships with each release so Leanfare works offline; a fresh one is downloaded at start and once a day. OpenRouter prices come from OpenRouter's own model list, read on your computer. `bun scripts/licences.ts` checks that every source is still open for business use.

Leanfare is not affiliated with any AI provider.

## Known limits

- Estimates before sending are estimates: nobody knows an answer's length in advance.
- The task guess is rules, not a trained model, so some tasks are guessed wrong. The reason is shown so you can spot it.
- Arena ratings measure what people prefer, not correctness.
- Prices are list prices; discounts and contracts are not known.
- The successor rule can be wrong; it is shown 30 days ahead and can be changed.
- While a budget is on, an answer without a limit of its own stops at 4,096 tokens (8,192 for thinking models), and the chat says so. Set a limit in the request, or turn the budget off, for longer answers.
- In this version, tools with Claude models work through `/v1/messages`, not through the OpenAI address.

## Develop

```sh
bun install
bun test                     # against fake providers; nothing leaves your computer
bun scripts/smoke.ts         # starts the real command, uses it, stops it
bun scripts/preflight.ts     # versions, types, tests, licences, smoke
bun scripts/build-data.ts    # refresh the shipped catalogue from today's llmledger data
```

TypeScript on Bun, with no run-time dependencies: Bun's own server, fetch and SQLite.

## Licence

MIT
