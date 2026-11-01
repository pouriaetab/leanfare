# Changelog

## 0.12.0

- Review every answer: each answer Leanfare brings back ends with a line that asks your app to check it, grade it and fix it before it answers you, by itself or by asking Leanfare again one tier up with what was wrong (`grade` with `fix`). In Claude Code a Stop hook asks once for any hand off left without a grade.
- The level, from 1 Off to 5 All it can (3 More at first): how much your app hands to Leanfare first. A knob in Settings with what each level does beside it, one level per app if you like, raised by itself when your Claude plan runs low, and set for one chat by asking ("Leanfare 4"). The report shows quality by level.
- Your Claude plan's use is read by itself through Claude Code's own usage view while Leanfare runs, so a day spent in Cowork or Claude Desktop still raises the level when the plan runs low. Leanfare never touches Claude Code's sign in, and stops asking if it would cost anything.
- What Leanfare keeps: a second knob, from numbers only (as before, the default) to a hand off's task, answer, file names and file text, kept on your computer for 7 to 90 days, with Delete all. Savings then shows each part's words (**Read the words**, with Copy), and **Export CSV with the words**.
- Ask about these prompts: a box in Savings answers a question over the prompts it shows ("which cost the most?"), read by a model on your computer, so they never leave it; another of your models only if you pick it.
- Where work may go: a small knob from only this computer, to also paid models that do not train, to also free tiers (not your files), to anywhere you ticked, with how many of your models each stop leaves and a warning when none. Your older choice for files carries over.
- Live tokens: Savings shows each model call as it runs, its tokens by kind (new input, cached, thinking, written) as moving bars, lanes over the last minute, or numbers. The `live` tool shows the same in your app, as a live card in Claude Desktop and Cowork.
- One-click install: each release has a `.mcpb` file for Claude Desktop on Macs and Windows (double-click it), and `server.json` to list Leanfare in the official MCP Registry.

Fixed from 0.11.3:

- In Cowork, the review line and the level's advice now reach the model (Cowork passes only a tool's structured result on).
- A test that expected the month to be October.

## 0.11.3

- Report a problem, in Settings, opens a bug report on GitHub with your Leanfare version and system filled in. You read it and send it yourself; Leanfare sends nothing.
- The repository has bug and feature forms, Discussions for questions and ideas, a pull request template, and a README that says how to report a problem.

## 0.11.2

Fixed from 0.11.1:

- Cowork is called Cowork in the report and in plans (its door gave the name local-agent-mode-leanfare), and is one of Claude's apps there: a plan names your Claude plan and Anthropic's models for the parts that stay with you, and follows your plan's mode. Hand offs saved under the old name read Cowork.
- An app on Leanfare's OpenAI address that asks Auto for a whole answer gets the next pick's answer when one model's answer comes back empty twice, as the chat and the delegate do since 0.11.1.
- A free key's requests through Leanfare today count every answer it sent, empty ones too, as the provider counts them.
- A model the provider no longer serves to your key (Google answers "This model ... is no longer available to new users") is left out of Auto, plans and checks, with the reason and Try again in Settings, and a request that reached it goes to Auto's next pick instead of failing.

## 0.11.1

Fixed from 0.11.0:

- An answer still empty, or cut off again, after Leanfare asked the same model once more now goes to Auto's next pick, once, and the receipt says so. Before, the hand off failed even when another model you ticked could take it (some Gemini answers come back empty twice in a row). A model you named is still not swapped.

## 0.11.0

- Plan modes: plenty, low and very low, from how much of your Claude plan is used and how fast. Low (70% used, or running out before it resets at this week's pace) tells Claude to hand off all reading, searching and drafting it will not change, reminds it sooner before big reads, and sends a plan's high effort parts out too; very low (90%) sends out everything that can go. Nothing is ever stopped. Settings shows the mode.
- Jobs: Settings says where each kind of job goes in a plan: to Leanfare, to Leanfare only when your plan runs low, or kept with your app. By default reading and searching go to Leanfare, drafting goes when your plan runs low, and working things out stays with your app. A cap for paid work, $0.10 a hand off at first: a cheaper or free model first, and a hand off or a check that would cost more stays with your app.
- Grades as a score out of 100 with its range (good counts 1, partly half, wrong 0), in the report, the card in Claude, Settings and the `grade` tool's answer. You still press Good, Partly or Wrong.
- Claude Code is reminded once before it reads a big file itself (a log, data or docs of 40 KB or more, any other text file of 200 KB or more) that Leanfare's delegate can read it instead; reading it again goes through. Plan by itself now hands off by size, not only for tasks with several parts, and is brought up to date when Leanfare starts.
- A door older than the app: when an app keeps an older `leanfare mcp` running after an update, its calls, its tools and its pages go through the updated app, and it says so once.

Fixed from 0.10.0:

- A model your key has no quota for (Google's free tier for Gemini 4 Argon answers every request "limit: 0") is left out of Auto, plans, checks and side by side, and Settings and the report say why, with Try again; a new key clears it.
- A free plan's models count at $0 when Auto picks, as they do on the bill: a free Gemini key no longer loses to a cheaper paid model.
- A plan is split by a model that answers within about 15 seconds by its record, and a try that does not start in 12 seconds goes to the next pick, so a slow model no longer runs the split out of time. A list of questions is no longer split like code: the facts are read outside, and the answers stay with your app.

## 0.10.0

- Both sides of each hand off. The report shows what the outside models used, measured from the providers' own counts: what they read, thought and wrote, for every call of a hand off (its answer, a second try, its check, side by side). Next to it, what your app would have used doing the part alone, as an estimate with its range; what handing it off cost your app (the task it wrote, the answer and receipt it read back); and the saving. Your app's own use of the whole prompt is measured where its files say (Claude Code's), and not known elsewhere.
- Quality three ways: the outside answers (your app's grades, else the blind checks), the whole result of a prompt, your app and the hand offs together (your app grades it with the `grade` tool, or you do in the report), and your app alone, where side by side could run your app's own model on a sample.
- Speed and failures for each model: a dot for each model (time for an answer against how often it was graded good) and a table of its calls, failures by kind (busy, rate limited, timed out, out of reach), its first word and whole answer (the middle one and the slowest 1 in 10), how fast it writes, its cost a call and its grades. Claude gets a line of it in the report.
- A model that keeps failing rests: when 3 of its last 6 tries in 30 minutes failed, Auto picks others for 30 minutes (5 for rate limits, longer if it keeps failing), and the receipt says why. A try that does not start answering in time is given up and passed to the next pick. The report shows each rest, with **Try it now**.
- Picks that learn from your history: your grades and the blind checks move a model's rating for each kind of work (up to 60 points), a model's time is learned by the size of the input and its recent failures, and a new speed, **A balance of time and cost**, picks the quick one among models as good and as cheap.
- Free plans for Groq and Mistral, next to Google's: tick it for a free key, and its answers count as $0. Groq's free plan takes only work that fits its 8,000 tokens a minute; Mistral's free plan may train on what is sent, and says so.
- Perplexity through its Agent API: Sonar's chat completions moved there, so searches go to `perplexity/sonar` with web search on.

Fixed from 0.9.0:

- The trial's test of an answer's own time holds on a busy computer.
- A prompt's time in the report reads the same on every computer ("Oct 20, 10:05 AM"); some showed "Oct 20 at 10:05 AM".

## 0.9.0

- The report: Savings opens with what Leanfare did for your apps over any span, from the last hour to a year: the tokens kept out of your plans, your apps' own use where it is known (Claude Code's, from its own files; Claude's chats and Cowork do not share theirs, so they show as not known), the cost and the quality. Tokens over time, work by model, quality by kind of work, and each prompt with the models it handed work to and how good their answers were, under an id that is kept (PRM-41, and PRM-41.2 for a part). Filters by app, provider, model, kind of work and thread, and Export CSV. Ask Claude for Leanfare's report (the new `report` tool) and Claude Desktop and Cowork show it as a card in the chat.
- Fair grades: checks are blind, and come from a model of another company when one can take them; what an answer says of its own model is masked. Side by side: on 1 in 10 hand offs at first (at most $1 a month), the best rated model you ticked answers too, after the answer went back, and a model of a third company compares the two blind. Settings shows how close each model comes for each kind of work.
- Plans name every model: a part that stays with your app names your app's own model and your plan ("you (Claude, on your Claude Max plan)", Claude Opus 5.5), and each hand off keeps them. A plan's numbers say they are estimates, and a question small enough to answer yourself is not split.
- Show who wrote what (a test, off at first): each paragraph of an answer handed back to your apps is marked with the model that wrote it.

Fixed from 0.8.0:

- Local models that think (qwen3.5 and others) no longer fail the reading test: they answer without thinking at low effort, and get room for their thinking otherwise.
- A plan's limits say when they were read, and that a reading more than an hour old may be behind: Claude's chats and Cowork use the same limits without telling Leanfare.
- Cloud models that think get room for their thinking, and an answer that hands back only its thinking is asked again.
- Side by side's rows in Settings show the whole model name, the top model and the judge.
- Tests get the 20 seconds they were meant to have.

## 0.8.0

- What Leanfare did for your apps: Savings opens with the share of the work for your apps (plans and the delegate) that stayed out of your plans, in tokens too, what it cost and where it ran, how good the answers were (your apps' grades and the checks), and the last few tasks, a plan's parts on one line. A plan says the share of the task it keeps out, and the `spend` tool says all of it.
- Your own models, tested here: Settings, Local models says where Ollama keeps your models (an external drive too, with its free space; downloads go there), suggests one for each kind of work (reading, drafting, working things out) with its size, and tests a model you have on 8 questions with known answers, on your computer. One that passes takes reading work first in plans and the delegate, for free. Ollama models on an attached drive that Ollama does not use can be used where they are.
- Where Leanfare may send work: Settings lists Claude, ChatGPT, Gemini, Grok, your own models and the others you have a key for, each with a switch (off: plans and the delegate leave it out) and what is left before its nearest limit: a plan's 5 hours before its week, a free key's requests today, or your budget.
- Free tiers marked: a free Gemini key ("people may read it", by Google's terms) and OpenRouter's free models are marked in Settings, in plans and in receipts. Settings chooses where your projects' files may go, and an app can keep one task or plan on your computer (private).

Fixed from 0.7.0:

- A plan's split by a model answers within 40 seconds; a model that takes longer is let go and the rules split the task (Cowork waits 60 seconds for a tool).
- A plan's parts run on the model its table names. When that one cannot answer, another takes it within the same limits, and the receipt says which and why.
- A hand off answers within about 40 seconds: the answer, or an id while it keeps working, and delegate with only that id gives the answer.
- The plan's card in Claude Desktop and Cowork follows a run Claude started, so the chat shows one next step, not two.
- Savings cards keep their height in a short window; the trial card could shrink to its title.
- Tests take a port nothing listens on.

## 0.7.0

- Simple to start. The first time, Leanfare opens on Set up: the AI apps on this computer and the models it can hand work to, and one press, **Turn on Leanfare**, adds it to each app. Then it opens on Chat, with the one step each app needs at the top. When no model you ticked can be used yet, Set up ticks the first models of each provider you have, and with none it offers the quickest way to get one: Connect OpenRouter, add a key, or a free model for Ollama. Settings, In your apps, **Set up all at once** runs it again.
- One switch at the top, **In your apps**, turns Leanfare off and on in all your apps at once. Off, its tools hand nothing over and your apps do the work themselves; running plan parts and the trial stop, and a line at the top says it is off.
- Day, Auto and Night at the top right. Auto is day from 7 AM to 7 PM by this computer's clock; the colors are set before the page is drawn, so it never flashes the wrong ones.
- A short README; the details are in the guide, `docs/GUIDE.md`.

Fixed from 0.6.0:

- A folder where an app's settings file should be no longer stops the list of apps; that app is shown as one Leanfare leaves alone.
- The plan's page in Claude Desktop no longer shows the word "null" when no local model fits this computer.

## 0.6.0

- Your ChatGPT plan, through Codex: turn it on in Settings, and a plan's reading, drafting and working out parts run on Codex, signed in with ChatGPT, before any pay per use model. Read only, in the folder of their files, without your MCP servers, apps or plugins, two at a time; they count toward your ChatGPT plan's Codex limits, and Leanfare pays nothing for them. Leanfare leaves Codex alone near 85% of the plan's 5 hours or week.
- Grades: the app you work in grades each answer of Leanfare's it used (good, partly or wrong) with the new `grade` tool, and you can in the Plan tab. A model graded below good too often for a kind of work is moved down, so plans and the delegate pick better over time. Settings, How the models did for you, shows the grades and gives a model another chance. Only the grade is kept, never the words.
- Models on your computer: Auto and plans use Ollama's models at the rating of the same model in the cloud, 15 points lower, and send them only plain prompts that fit their context.
- A local model for this computer: Leanfare suggests the best rated open model (Apache 2.0) that runs in this computer's memory and fits on its disk, in Settings, in the plan, and as the new `local_model` tool. Ollama downloads it only after your yes.

Fixed from 0.5.0:

- Models in Ollama no longer cut long prompts at Ollama's default of 4,096 tokens: Leanfare asks for the context the prompt needs, up to 16k, and a model chosen by name says when a prompt is longer than that.

## 0.5.0

- Plan a task across models: write what you want done, and Leanfare splits it into parts with where each runs and its model, as a table with the time, the tokens kept out of your plan and the cost. Changes to your project and the hardest judgement stay with the app you work in, each with the model to pick there (in Claude Code: Opus, Sonnet or Haiku, by the part); reading and drafting go to local, free or cheap models, at once where they can. In the new Plan tab, and as the MCP tools `plan`, `plan_run`, `plan_status` and `plan_stop`.
- Paid parts of a plan run only with your yes, or up to an amount you set in Settings; parts on local and free models run on their own, their checks too. The answers are saved in the project's `.leanfare` folder, which git ignores.
- Claude Desktop and Cowork show the plan as a page in the chat, with Run, Stop and the answers as they come.
- Plan by itself: Claude Code, Codex and Gemini CLI can call the plan on their own for a task with several parts. In Claude Code this adds a worker subagent for Leanfare's parts and a prompt hook that says how much of your plan is left.
- Your subscriptions in tokens and limits: Savings shows what you used and what is left, with smaller tiles. What that use would cost at API prices is now a choice in Settings.
- Savings finds the AI apps on this computer and counts each plan only in its own months (a start month, and an end month for a plan you ended). Grok plans are new.
- Short answers in the chat by default: the answer first, a table or a short list, more only when you ask. Settings can turn it off.

Fixed from 0.4.0:

- A plan's run hands over the files its parts name, measured by the app that named them.
- Leanfare's own changes to an app's files no longer count as using that app, and looking for apps no longer holds up the server.
- The estimate before sending counts the short answers line.

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
