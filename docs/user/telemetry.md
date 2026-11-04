# Product usage data

Sharing anonymous usage data is **off by default**. Nothing is collected or sent unless you turn it
on, and it is never sent to T3 Code's servers.

The build you get from this repository has no usage-data destination, so it cannot send usage data at
all. **Settings > Privacy** links to the [privacy policy](../../PRIVACY.md) and shows no sharing switch.

## If a build offers it

A build that names a destination in its brand config shows **Share anonymous usage data** under
**Settings > Privacy**. When you switch it on, the server sends product events to that destination:
the provider, model, reasoning effort, permission mode, turn and request results, duration, release
channel, app version, and token counts when available. Child-agent token counts are reported
separately from the main agent's. Model names are sent only when they appear in a provider's public
model list.

Events are tied to a random installation ID. To count how many installations one person uses, they
also carry one-way hashes of the OpenAI and Claude accounts you are signed in to and of each device
that connects.

Events never include prompts, responses, file contents, footage, transcripts, file paths,
authentication tokens, conversation IDs, raw provider events, or child-agent output.

## Environment variable

`S7VIDEO_TELEMETRY_ENABLED=true` or `=false` in the server's environment overrides the setting.
When it is set, the switch shows which variable decides. The desktop app reads it from your shell
profile (for example `~/.zshrc`), so export it there and restart the app. Upstream's
`T3CODE_TELEMETRY_ENABLED` is ignored.

An administrator can keep usage data off for every user on a machine with a
[managed policy](./managed-policy.md#other-capabilities). A policy cannot turn it on.

## Export diagnostics to your own receiver

Diagnostics go only to a receiver you configure yourself. To send traces, metrics, or logs to an
OpenTelemetry receiver, open **Settings > Maintenance > Diagnostics**, select an environment, and
enter each signal's OTLP HTTP endpoint under **OpenTelemetry export** (for example
`http://localhost:4318/v1/traces`). Save, then restart that environment's server. The receiver must
be reachable from the server's machine. **Test** sends an empty export from the server to check an
endpoint before or after you save it; saved endpoints are checked when the section opens. Checks send
authentication headers only to the signal's currently running endpoint and do not follow redirects.
To check a new endpoint that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.

The app keeps its own traces in the logs folder on your computer, for the Diagnostics page; they are
not sent anywhere unless you set an endpoint above.
