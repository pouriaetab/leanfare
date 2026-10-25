# Security

Leanfare runs on your own computer and listens on 127.0.0.1 only. It keeps your provider keys in the macOS Keychain (elsewhere, in a file only you can read), sends each key only to its own provider, and sends nothing anywhere else: no telemetry.

It reads usage numbers, never your words: from Claude Code's and Codex's log files it takes only the model, the time and the token counts. The MCP server's `delegate` tool reads only the files it is handed, refuses files that hold secrets (`.env` files and their kin, private keys, credential and token files, and anything in `.ssh`, `.gnupg`, `.aws`, `.git`, a keychain or Leanfare's own folder), and sends them only to the model it picks.

To report a security problem, use GitHub's private vulnerability reporting on this repository (Security, Report a vulnerability) rather than a public issue. Please include the version (`leanfare --version`) and the steps to see it.
