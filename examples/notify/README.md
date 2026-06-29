# notify backends

Atrium pushes a flag alert by running `config.notify.sendCmd` as an argv array with the
alert **message appended as the final argument**. No shell is involved — the command is
invoked directly via `execFile`. Anything that takes a message as its last arg works.

Set it in `~/.config/atrium/config.json`:

```jsonc
{
  "notify": {
    "enabled": true,
    "minSeverity": "crit",       // info | warn | crit
    "sendCmd": ["ntfy", "publish", "my-topic"]
  }
}
```

An empty `sendCmd` (the default) disables push entirely — flags still appear in the
dashboard, nothing leaves the machine.

## ntfy (self-hosted or ntfy.sh)

```json
"sendCmd": ["ntfy", "publish", "https://ntfy.sh/your-secret-topic"]
```

## webhook (Slack / Discord / generic)

`sendCmd` invokes one program; for a webhook, point it at the small wrapper script in this
directory and pass your URL via an env var or by editing the script:

```json
"sendCmd": ["/path/to/atrium/examples/notify/webhook.sh"]
```

See [`webhook.sh`](webhook.sh).

## hermes (the author's telegram setup)

```json
"sendCmd": ["hermes", "send", "--to", "telegram"]
```

This is what atrium shipped wired-in before it was generalized; kept here as one concrete
example of an external CLI backend.
