# Changelog

## 0.4.0

- Install with one line: Leanfare is now one file for macOS, Linux and Windows, with an installer that checks the download against the release's checksums. Leanfare says when a new version is out (Settings can turn that off).
- Use it in your apps: one press adds Leanfare's tools to Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code and LM Studio, changing only Leanfare's own entry. In Terminal: `leanfare apps`.
- Set up without typing: paste any key and Leanfare knows whose it is; keys your login shell exports reach the Mac app too; Find my keys offers the keys in other AI tools' files on your computer, each used only after you tick it; model apps running on your computer (LM Studio, Jan, llama.cpp, vLLM, LocalAI, KoboldCpp, GPT4All, Lemonade) are found on their own; and any provider that speaks OpenAI's format can be added, from the list of known providers or by its address.
- New providers: Perplexity (its own cost, search fee included), Groq, Cerebras, Together AI and Fireworks.
- Your subscriptions, apart from pay per use: Claude, ChatGPT, Perplexity, Google AI, Copilot and Cursor plans with their limits. ChatGPT's plan is read from Codex's logs, including its compressed and archived sessions.
- Speed: every estimate shows its time, measured from each model's own answers. At the same quality, choose the cheapest, the cheapest within a time, or the fastest, in Settings, beside the message box, per request (`x-leanfare-speed`) or per hand off.
- The trial: ten questions with known answers at three efforts say how well the delegate does on your models, and which effort Claude can rely on. In the app, in Terminal (`leanfare trial`) and as an MCP tool, with results you can share.
- The estimate tool names the cheapest and the fastest choice at the same quality; the delegate's receipt says how long it took.

Fixed from 0.3.0:

- The delegate answers in the form the task asks for (names, numbers or text), not where to find them; the trial on low effort found this.
- On the Savings page, a session's share of the week reads "under 0.1%" when it is that small, not 0.0%.
- `leanfare stop` and `leanfare status` act only on the Leanfare of their own data folder. With another copy running (the Mac app, for example), stop could end it.

## 0.3.0

- Connect OpenRouter: sign in on OpenRouter's page and Leanfare gets a key, with nothing to copy. Settings shows the credit left.
- Local models: download and remove Ollama models in Settings, by name or straight from Hugging Face, with a progress bar, a check that each one fits your memory, and 10 GB of disk always kept free.
- Your plans: what your Claude Code and Codex use would cost at API prices, next to what you pay. The Mac app's menu shows it too.
- What is left of each plan: the 5 hour and weekly limits as bars, the work left in dollars and tokens with a 90% range, and which of your projects still fits. Claude's percentages come from Claude Code's status line, which Leanfare can fill (`leanfare statusline`), keeping a line you already had.
- The delegate: through the MCP server's new `delegate` tool, Claude hands reading heavy work to the cheapest model that is good enough. Leanfare reads the files itself, never files that hold secrets. A stronger model checks a sample of the answers, and a failed one is asked again one tier up. Savings shows what was handed over and how the checks went.
- Privacy, said plainly: Leanfare reads usage numbers, never your words.

## 0.2.0

- Attach images, PDFs and text files to a message. Auto picks a model that takes them, and they count in the estimate and the budget by their tokens.
- Edit a question and send it again, ask again, or ask another model and compare the two costs.
- Instructions for each chat, and a default for new chats.
- Search across chats; export one chat as Markdown or all of them as one file; import from ChatGPT, Claude or a Leanfare export.
- Thinking: what thinking models think is shown folded above the answer, and an effort setting (low, medium, high) goes to the models that take it.
- An answer that comes back empty or cut off is asked for once more, and says so.
- An optional access key for the addresses other apps use.
- Claude's hour long cache writes are priced at twice the input price; long context prices are used when the data has them.
- The Mac app: today's spend in the menu bar, the chat in a window.
- `leanfare mcp`: an MCP server for Claude Desktop and other MCP clients.

Fixed from 0.1.0:

- A request asking for several answers at once (OpenAI's `n`) is reserved in the budget as several.
- With "keep going on the cheapest model", Auto's next pick is no longer let past the budget when it is not the cheapest model.
- A long message pasted as one line (a DNA sequence, a minified file) no longer slows every request while its task is guessed.
- Pressing Esc while renaming a chat keeps the old name; Esc in the search box or the picture viewer no longer stops an answer; the second click of a double click on Send no longer stops the answer it sent.

## 0.1.0

- The engine: an OpenAI-compatible address and Anthropic's `/v1/messages`, with the cost of every answer, automatic model choice, a budget that holds, retirement warnings and a cost ledger.
- The app: chat, savings and settings, at `http://127.0.0.1:4747`.
