# Changelog

## 0.15.2

- Fewer questions in Cowork. Switched off, Leanfare tells your apps level 1 and not to call its tools, so the leanfare-level mod adds nothing to the prompt; before, the level tool still gave the knob's level, and Cowork kept asking about Leanfare's tools. On, the level line says not to call the level tool again, and a plan's answers are graded in one call: `grade` takes the plan's id, `grades` for each part, and `whole` for the whole result.
- A **Refresh** for the report's prompts, with the time they were last read. The table also reads them again every minute while it is open; before, a prompt that came in after you opened the report did not show until you opened it again.
- Savings takes less room: less space around its parts, and smaller text on the view switches, By prompt and By model, the filters and the pages.
- Switched off, Leanfare picks no model for Claude's helpers, so they run on the model your app picks. What each used is still kept.
- A `glama.json` file names who keeps the server, for Glama's list of MCP servers.

## 0.15.1

- Fewer questions in Cowork. Cowork can ask you before each helper starts, and a plan used to ask for a helper per part. Now Settings, Claude's own models, Helpers, says how many: one per prompt (the default), one per part, or none. One per prompt gives one helper the parts that need a stronger model than the chat's own, on the strongest of them, and the rest run in the chat; none runs every part in the chat.
- Live activity keeps the last calls, with when they ended, until new ones come. Before, a minute after the last call it went empty as soon as you pressed a bar or picked Lanes or Numbers.
- A part's files are kept however your app names them: by full path, with ~, inside the project's folder, or as a folder for every file in it. Before, a part that named its files by full path went out with none.
- A shorter README with new pictures, and what is inside: the MCP server's source, its tools, and how to build it.

## 0.15.0

- Claude is the platform. Leanfare lives in Claude Desktop, Cowork and Claude Code only; an earlier install in Cursor, Codex, Gemini CLI or another app shows in Settings with Take it out. Codex and Gemini CLI still take Leanfare's parts as outside models, with the free and paid models you pick.
- Each helper Claude starts runs on the Claude model Leanfare picks, as an order: the leanfare-level mod sets it in Cowork and Claude Desktop, and a hook in Claude Code. The order comes from llmledger's ratings and prices, so a new model takes its place the day it is listed and a retired one drops out. As the ratings stand: Fable 5.1 for the hardest parts and final checks, Opus 5.5 for high effort, Sonnet 5.5 for medium, Haiku 5.5 for light code. Your rules hold Fable back (Settings, Claude's own models): only while the week is under 80% used, at most 20 helpers a day, and not for an hour after a helper on it failed.
- The plan names each model with what it is to you: the main model, a platform model (another of Claude's, on a helper), free, paid, this computer, or the subscription it counts in. A change that names no files stays with your app at level 4, since there is nothing to draft a patch against.
- The Usage report's prompts are one table, By prompt or By model: a prompt opens to its main model, each of Claude's helpers and each outside model, in the same columns. The span comes from a calendar (one day or a range, or a quick pick), columns move and hide, and you pick the rows per page. Each prompt shows the main model and its effort, Claude's helpers and the outside models with their tokens by kind, and their totals. Cowork's and Claude Desktop's own tokens count too, as the mod says them.

## 0.14.2

- Smaller and tighter everywhere: text a size below Claude Desktop's (20, 14, 13, 12 and 11 px; chat messages stay 16), less space around cards, rows and buttons, and thin bars in Work by model, Quality by kind and by level, the tiles, the meters and Live activity.
- Live activity shows each kind's number (new input, cached, thinking, written) in its own color beside the bar, as it moves.
- The Usage report: Prompts has its title in the table's header line, Ask about these prompts is one line with three short sample questions (the whole question on hover), Models is one table with speed and score as thin bars in their cells, and Tokens over time is lower.

## 0.14.1

- Plan first in every app that lets Leanfare in. At levels 4 and 5 the first tool call of a prompt that is not Leanfare's plan is turned back once, with the reason, and the next goes through: in Claude Code (a hook next to the read hook), Codex (its hooks.json, which also says the level with each prompt), Gemini CLI (BeforeAgent and BeforeTool) and Cursor (its hooks.json).
- Cowork and Claude Desktop: a mod, leanfare-level, puts Leanfare's level in the system prompt of every chat and asks for the plan first at 4 and 5. Install it from Leanfare's plugin marketplace (the guide says how).
- Always on: the Mac app opens at login (its menu turns it off) and starts Leanfare again when it stops, up to 3 times in 10 minutes. Without the app, `leanfare service install` adds a LaunchAgent (macOS) or a systemd user unit (Linux). An app's door waits up to 20 seconds for a start and says why one failed.
- Your Google account through Gemini CLI: turned on in Settings, a plan's parts run on it read only before anything paid. Working in Codex or Gemini CLI, Leanfare's parts go to a lighter model of the same plan.

## 0.14.0

- Level 4 sends more out. Working things out below high effort goes to Leanfare's models like drafting does, and a change to files is drafted outside as a patch (a unified diff) that your app reads, applies and grades. At level 4 the hardest working out still stays with your app's strongest model; at 5 it goes out too. Free models take working things out at medium effort from level 4, where every answer is checked by a second model. Jobs you set by hand stay as you set them.
- Claude Desktop and Cowork hear which of Claude's own models (Opus, Sonnet or Haiku) a part that stays should run on, as Claude Code does: Cowork can start a helper on that model; the Desktop app's chat does the part itself.
- Checks set once per project: your app gives a plan a short list (the tests to run, a scan, words to keep out of what comes back, what to look at). Leanfare keeps it for the folder, shows it with every plan made there, scans each answer for the words itself, and your app reports the rest with grade. Settings, Jobs and plans, Project checks, lists them.
- The loop: at levels 1 to 4 your app's own split comes first, and Leanfare places each part; at 5 Leanfare's model splits. A part your app grades partly or wrong goes out again inside the plan, one tier up, to another model, with what was wrong; the last of three rounds may go to a paid model within your caps, and a part missed in all three is your app's. Your app's own parts are rows: once done, the parts that waited for them run with their answers.
- In Cowork, a plan's next steps and checks are in the part of the result Cowork shows the model.

## 0.13.12

- Text follows the sizes Claude Desktop uses, everywhere: a screen's one title, section titles, text, secondary text and small labels (22, 15, 14, 13 and 12 px), chat messages a size up (16 px), and buttons 32 px high. The cards Leanfare shows in your apps' chats use the same sizes.
- Savings is compact: each group, open, fits one screen. The report has four views, one at a time: Overview, Prompts (ten at a time), Models and Quality. Numbers show with one short line; a card's longer words are on hover, or under its title after one press of its i. Monthly overview has the month and Refresh on its first card's title line, and a subscription's windows on one line each.
- Settings is compact too: each group, open, fits one screen (How much Leanfare does, Where work may go, Jobs and plans, Budget and Your subscriptions are now apart, and Look sits with Instructions for new chats). A switch's line and a card's description wait behind its i; the levels show what the picked one does; each platform is one line.

## 0.13.11

- Savings' groups have clear names: Live activity, Free capacity, Usage report, Monthly overview, API spend and Model trial. Free capacity opens and closes on its own, and its title line says how many models are in use today.
- Monthly overview replaces the group named after the month: it shows the current month unless you pick another in its picker, moves on by itself when a new month starts, and says the month on its title line.
- Free capacity is denser: smaller text and several models to a row, each on one line with its name, a thin bar and its count. A used up one says when it is back, and the tooltip has the rest.

## 0.13.10

- Savings is compact: its sections sit in groups (Now, Report, the month, Pay per use, Try the delegate first) that open and close and keep how you left them, and a closed group says its gist on its title line. Pay per use and the trial start closed.
- Free models today shows one line a model, with its name, a thin bar, what it used of its daily limit and when the limit resets, instead of a box each.
- Live, with nothing running, shows only its title line and your last hand off.

## 0.13.9

- Claude Code now hears its level as a plain first step: at level 4, Leanfare's plan tool is its first tool call for each prompt that is more than a quick question, named so Claude Code can find it, with the reason (so your Claude plan lasts longer). Before, it heard the level with every prompt but used Leanfare only when asked by name. The reminder before a big read names Leanfare's delegate tool the same way.

## 0.13.8

- Free models get the work they do well. Your grades of all the free models now count together, by kind: working things out at medium or high effort waits until free models earn it (60 of 100 from 5 grades), and any kind they score under half at waits. A paid model you ticked takes it, or your ChatGPT plan through Codex, or your app keeps it, and the receipt says why. Low effort work still goes to them.
- When Claude Code runs prompts for a week and hands nothing off, a notice says why: Leanfare's line never reached it, it never opened Leanfare's tools, or it had both and still handed nothing off. To tell, Leanfare now notes each prompt its line reaches and each app that opens its tools (names and numbers only).

## 0.13.7

- Live, with nothing running, shows your last hand off (when, the model, the tokens kept out, the cost) and this month's work, so the top of Savings is never empty after a hand off ends.
- Fixed: a small OpenRouter balance counted as no credit ("You requested up to 12288 tokens, but can only afford 8805"), so hand offs and checks failed and its paid models were set aside. Leanfare now asks again within what the balance covers; only a balance too small for a real answer counts as no credit.
- Fixed: a receipt could say a provider's paid models were left out when one of them had just answered.
- Fixed: in Free models today, long names ran over the next tile; and models your key cannot use (gone, no quota, or a provider turning requests away) no longer show there.
- Fixed: Live could keep saying "Connecting to the live numbers…" after it had connected.

## 0.13.6

- Retiring models, said once: a free model that retires needs nothing from you, so it gets no notice (its row in Settings says when). Other retirements share one line at the top, with the date in words, and a **×** hides it until another model retires.
- Fixed: a free model retiring was set to switch to its paid copy (OpenRouter ends a model's free copy while the paid one goes on). A successor is now always of the same kind: free stays free, paid stays paid. With no free replacement, a free model is no longer used from its retirement date.
- Fixed: OpenRouter's free models said "(free)" twice.

## 0.13.5

- Quiet about what lasts: a notice about no credit, a refused or expiring key, or a provider turning requests away has a **×** that hides it until the problem changes; the provider's card in Settings still shows the problem, with its own **Check again**. A hand off's receipt mentions each of these once a day instead of every time.
- When a provider blocks your network (a VPN, for example), Leanfare handles it quietly: it uses your other models and checks that provider again every 30 minutes by itself. There is nothing to do.

## 0.13.4

Fixed from 0.13.3:

- A provider that turned a request away for a reason other than the key or credit (Groq's 403 "Access denied. Please check your network settings.") ended the hand off, and Leanfare called it a refused key. Now Auto passes the work to the next model at once, skipping that provider's other models, and leaves its models out while it keeps refusing; the page says so with **Check again**, and Leanfare checks again by itself every 30 minutes. A refusal about one model leaves out that model only, and one about the request just passes the work on.
- A hand off now asks up to three models even when some of Auto's picks belong to a provider that just failed: those are skipped instead of counted.

## 0.13.3

Fixed from 0.13.2:

- A provider with no credit left (OpenRouter's "requires more credits", DeepSeek's "Insufficient Balance", Anthropic's "credit balance is too low") no longer fails hand offs and checks. Leanfare leaves its paid models out and passes the work to your next model, its free models keep working, and the page says so with **Add credit** and **Check again**. OpenRouter's balance is read again every 30 minutes and the others are tried again after 6 hours, so they come back as soon as there is credit.

## 0.13.2

- What you spent, call by call: press the spending pill at the top, or the Mac app menu's spending line, for each call that cost something this month: when, the model, what it was for, its tokens and its cost, with Show all.
- Free models, compact: Savings shows a small tile for each free model used today, with its daily limit and when it resets, the most used first; Show all adds the rest. Settings shows the connected free providers as chips, the others behind Connect more.
- Codex's model setting fixed in one press: when Codex's own settings name a model ChatGPT no longer offers, the ChatGPT row says so, and **Fix it** turns that setting off.
- A privacy policy (PRIVACY.md in the repository), linked from the plugin for Claude's plugin directory.

Fixed from 0.13.1:

- Free models today read its numbers once and kept them until the page was reloaded; it reads them again each time Savings opens.

## 0.13.1

- A key a provider refuses (it may have expired): Leanfare leaves that provider's models out, so the work goes to your other models, and a hand off that tried it passes to a model of another provider. The page says so at the top with one press to make a new key (OpenRouter signs you in again, which makes a new key; the others open the page where their keys are made, next to the box for the new one) and **Check again**. A new key, an answer from that provider, or a check every 30 minutes that finds the key working again clears it.
- OpenRouter says when its key expires: Leanfare reads it as the key is saved and once a day, and says so from 7 days before.
- The plugin has its icon for Claude's plugin directory, a description for its marketplace, and install steps by link.

Fixed from 0.13.0:

- Every part on Codex failed when Codex's own settings named a model ChatGPT sign in no longer offers ("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account"). Leanfare now asks Codex which models it offers your account, runs the part on Codex's own pick (or the next), keeps it, and the receipt says how to change the setting.

## 0.13.0

- The plan runs by itself: in Claude and other apps, the plan tool starts Leanfare's parts at once (local and free ones, paid ones within your cap) and answers with those that finish within about 25 seconds; your app does its own parts meanwhile, collects the rest, reviews and grades them. The plan's page in the chat has no buttons any more: it follows each part from waiting to running, done, with Claude and checked, and says in one line where the whole plan is.
- Free and paid apart: on a key you marked as a free plan, Leanfare never picks a model that plan does not include (Google's free tier has no Gemini 4 or Pro model: they say "needs credit"). Each free model's daily allowance is known (Gemini 3.x Flash about 20 and Flash-Lite about 500 on a free key, Groq 1,000 a model, OpenRouter's free models 50 in all), counted, and learned smaller from a rate limit; a used allowance leaves the model out until its reset (midnight Pacific for Google). A model failing most of its tries today, or starting its answers only after minutes, is left out while another can take the work, and is not used as the judge.
- ChatGPT in one press: a ChatGPT row next to your apps installs Codex when it is not here, opens the ChatGPT sign in, and turns it on once you are signed in. A free ChatGPT account works. A hand off that none of your ticked models can take now runs on Codex, read only, and a plan's web search goes to Codex with its own web search when Perplexity is not ticked.
- The share planner: Leanfare learns how many parts of each kind you hand over on a day (numbers only) and shares out the free allowances by kind of work: it keeps a scarce strong model for what it is clearly best at when it could run out before its reset, spreads work away from a model near its allowance, and takes the fastest good enough model when you are waiting. It moves work only between models that are free to you, and says which and why in the receipt.
- Free models ready to connect: Gemini, Groq, OpenRouter, Mistral and Cloudflare Workers AI sit under the ChatGPT row, one line each. Connect opens the page where the free key is made and takes the key (OpenRouter signs in instead); the key is marked as a free plan and its free models are ticked. Providers models.dev lists with free models that Leanfare has not reviewed are shown apart, to add by name only if you trust them.
- Settings in groups that open and close, the everyday ones open, with each card's long explanation behind a Details line.
- The pill at the top that says something is running opens the Live view in one press, and Savings shows Free models today: each one's day so far and when it comes back.
- Each release now also publishes its server.json to the official MCP Registry by itself.

## 0.12.1

- A Leanfare plugin for Claude (`plugin/`): Leanfare's tools, its four Claude Code hooks and a short skill on when to hand work over and how to review it, in one folder that Claude Code, Cowork and Claude's plugin directory can install. It runs the Leanfare installed on your computer. Claude Code can add it now: `/plugin marketplace add pouriaetab/leanfare`, then `/plugin install leanfare@leanfare`. When the app's own hooks are already in Claude Code, the plugin's hooks stay quiet.

Fixed from 0.12.0:

- Ask about these prompts no longer fails when the newest prompt alone is longer than the model can read: it reads the part that fits, and says so under the answer.
- A model whose provider refuses a thinking effort (Google answered "Thinking level is not supported for this model" for a model the price list said takes one) is asked again without it, and sent none from then on, instead of the hand off failing.

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
