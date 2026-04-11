# gistdiff

Generate commit messages from a git diff using the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

Pipe any diff to `gistdiff` and get back a conventional-commit-style subject line — or the full subject + body, ready to pass straight to `git commit -F -`. One API, swap models freely.

## Install

```sh
npm i -g gistdiff
```

Requires Node.js 20+.

## Setup

`gistdiff` talks to the Vercel AI Gateway, so you need an API key.

```sh
export AI_GATEWAY_API_KEY=your_key_here
```

You can also drop it in a `.env.local` at the repo root where you run the command — `gistdiff` will pick it up automatically.

## Usage

```sh
# Subject line only (the default)
git diff --cached | gistdiff

# Subject + body, piped straight into a commit
git diff --cached | gistdiff -d | git commit -F -

# Compare the default Anthropic + OSS models side-by-side
git diff --cached | gistdiff -c

# Compare specific models
git diff --cached | gistdiff -c openai/gpt-5,xai/grok-4

# Branch / PR summary
git diff main...feature | gistdiff -d
```

### Flags

| Flag | Description |
|---|---|
| `-m, --model <id>` | Gateway model id (default: anthropic/claude-sonnet-4.6) |
| `-d, --description` | Include a body paragraph, not just the subject |
| `-c, --compare [ids]` | Run multiple models side-by-side. Bare flag uses the built-in defaults; pass a comma-separated list to override. |
| `--list-models` | List available gateway models and exit |
| `--json` | Machine-readable JSON output |

## License

ISC © Joe McKenney
