# Security

Leanfare runs on your own computer and listens on 127.0.0.1 only. It keeps your provider keys in the macOS Keychain (elsewhere, in a file only you can read), sends each key only to its own provider, and sends nothing anywhere else: no telemetry.

It reads usage numbers, never your words: from Claude Code's and Codex's log files it takes only the model, the time and the token counts. The MCP server's `delegate` tool reads only the files it is handed, refuses files that hold secrets (`.env` files and their kin, private keys, credential and token files, and anything in `.ssh`, `.gnupg`, `.aws`, `.git`, a keychain or Leanfare's own folder), and sends them only to the model it picks.

A plan's parts get only the files they name, with the same refusals; a folder's dotfiles and links are left out. The answers are written only in the project's `.leanfare` folder, never through a link. Paid parts run only with your yes or within the amount you set. Plan by itself changes only Leanfare's own lines in `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, its own subagent file and its own hook entry, and keeps each file's links and permissions.

To report a security problem, use GitHub's private vulnerability reporting on this repository (Security, Report a vulnerability) rather than a public issue. Please include the version (`leanfare --version`) and the steps to see it.
