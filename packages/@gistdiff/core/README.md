# @gistdiff/core

Core library powering the [`gistdiff`](https://www.npmjs.com/package/gistdiff) CLI. Summarizes a git diff into a commit message via the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

Most users want the CLI, not this package — install `gistdiff` instead:

```sh
npm i -g gistdiff
```

## Programmatic use

```ts
import { summarizeDiff, DEFAULT_MODEL } from "@gistdiff/core";

const result = await summarizeDiff(diffText, {
  model: DEFAULT_MODEL,
  description: true,
  reasoning: true,
});

console.log(result.subject);
console.log(result.body);
console.log(result.cost); // usage + authoritative billing from the gateway
```

Requires `AI_GATEWAY_API_KEY` in the environment. Node.js 20+.

## License

ISC © Joe McKenney
