# Examples

How to integrate `@ctrl-arcz/sdk`. The SDK itself is headless (no UI) — these show
the two ways to consume it.

| Example                                                               | What it is             | Use it to                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`node-quickstart`](./node-quickstart)                                | A ~90-line Node script | See the full flow (firewall check → protected send → claim) with zero UI. The fastest way to understand the API.                                                                                                            |
| [`apps/sender`](../apps/sender) + [`apps/receiver`](../apps/receiver) | Two React + Vite apps  | See a complete **web UI** integration: wallet connect, the live firewall on the recipient field, protected send, code-gated claim, cancel/refund, gasless claim, i18n, dark/light. This is the reference "example website." |

The SDK never ships a website — a dApp brings its own front end. The apps above are
reference implementations you can read and copy from (they live in the repo, not in
the npm package).
