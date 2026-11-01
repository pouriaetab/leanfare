---
name: leanfare
description: Use Leanfare to hand reading, searching, drafting and checks to cheaper models so the user's Claude plan lasts longer. Use at the start of a chat to learn the Leanfare level, before reading big files or logs, before tasks with several parts, and whenever Leanfare hands an answer back.
---

# Working with Leanfare

Leanfare is a tool on the user's computer that runs simple work on cheaper or free models the user picked, and keeps that work out of Claude's plan. Its tools come from the `leanfare` MCP server.

## At the start of a chat

1. Call `level` with nothing to learn the level (1 Off to 5 All it can) and follow it. Pass that level to `delegate` and `plan`.
2. If the user sets one ("Leanfare 4", "use Leanfare less"), call `level` with `set`.

## When to hand work over

1. Big reads: logs, data, docs or code you will not change. Call `delegate` with the files in `files` (Leanfare reads them itself, so their text never enters your context) and a task that says what to find and the form of answer you want.
2. Tasks with several parts: call `plan` first. Leanfare starts its own parts by itself; do the parts it leaves to you, then read the rest of Leanfare's answers with `plan_status` (wait 50). Never run Leanfare's parts again with `delegate`.
3. Anything sensitive or personal: set `private: true`, so only models on the user's computer take it.
4. Code changes, decisions and anything the user must see you do yourself stay with you.

## When an answer comes back

1. Check it against its task before you use it.
2. Grade it with `grade` and the hand off's number: good, partly or wrong.
3. If it is partly or wrong, fix it before you answer: yourself (`fix: myself`), or with `fix: leanfare` and `why`, which asks again one tier up.
4. At the end of a prompt that handed work off, grade the whole result once (`whole: true`).

## Other tools

`report` shows what Leanfare saved and how good the answers were; `live` shows the model calls running now; `spend` shows the month's costs.
