# Leanfare

Every top AI model in one app on your own computer, with the cost of every answer.

Leanfare is in early development. This first part reads the price list and works out what a request costs: input, cached input, cache writes and output, each at its own price. Next come automatic model choice, a monthly budget that holds, a local address your other apps can use, and a chat app.

Prices come from [llmledger](https://github.com/pouriaetab/llmledger) (MIT), built daily from LiteLLM's public price list (MIT). Quality ratings come from the [Arena leaderboard](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (CC BY 4.0). `bun scripts/licences.ts` checks that every source is still open for business use.

## Develop

You need [Bun](https://bun.sh) 1.4.

```sh
bun install
bun test                     # against a fake provider; nothing leaves your computer
bun scripts/build-data.ts    # refresh the shipped catalogue from today's llmledger data
```

## Licence

MIT
