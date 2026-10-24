# Changelog

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
