# effort-pilot

Picks Claude Code's reasoning effort per prompt and trims token waste without hiding information.

- **Per-prompt pick**: local rules (zero tokens) rate each prompt. Routine commands drop to low/medium, hard work stays high, and only strong signals or an explicit ask ("think harder", "ultrathink") go higher. Follow-ups like "yes" or "continue" keep the effort already in force. Each change asks you first: Use / Keep / Always auto-apply / Stop for this session.
- **Claude's bypass**: Claude gets a `set_effort` tool to switch effort for the rest of a turn when it sees a faster route, or when it's stuck and needs more. You approve it unless auto-approve is on.
- **Token savers**: Bash output over 8000 chars is cut to its head and tail, with the full text saved to a file Claude can read. The first whole-file Read of a file over 800 lines is bounced once with its size, and repeating the call reads it. A ~60-token set of lean-work rules is added after the prompt-cache boundary.

`/pilot` shows status and stats. `/pilot auto on|off` toggles auto-approve, `/pilot on|off` pauses picks for the session, and `/pilot stats reset` clears the stats. Every option is also in `/config`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install effort-pilot --marketplace kiinect/effort-pilot
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install effort-pilot --marketplace kiinect/effort-pilot`. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `kiinect/effort-pilot`, then Add plugin.
