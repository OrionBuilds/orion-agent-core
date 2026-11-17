# agent-core

`@autom8ionlab/agent-core` is the shared foundation for the Autom8ion Lab AI agents, **Clara** (executive assistant) and **FRIDAY** (delivery manager). It holds everything both agents need, so each agent's own repo can stay focused on what it does.

It's a TypeScript library consumed from source. It isn't published to npm: the agents reference it as a sibling folder.

## What's in it

| Area | Folder | What it does |
|---|---|---|
| Owner and principals | `src/config` | Who the agent works for, who else may instruct it, quiet hours and preferences |
| Orion connection | `src/osauth`, `src/osmcp`, `src/ostasks` | Signs the agent in to Orion and calls Orion's tools over MCP, with per-agent tool allow-lists |
| Agent-to-agent | `src/interagent`, `src/bus` | Signed requests between Clara and FRIDAY |
| Work engine | `src/runner`, `src/workqueue`, `src/workerpool`, `src/deepwork`, `src/engines` | Queues, workers and long-running "deep work" jobs on Claude Code or other engines |
| Approvals and safety | `src/intent`, `src/outbound`, `src/notify-policy` | Decides what an agent may do on its own and what waits for the owner's approval |
| Skills and SOPs | `src/skills`, `src/sop`, `src/skilldiff`, `src/souls` | Loads skills and standard operating procedures, and the agents' personas |
| Memory and search | `src/vault`, `src/embeddings`, `src/store`, `src/sessionstore` | Notes vault, embeddings and local state |
| Integrations | `src/google`, `src/providers`, `src/proposals`, `src/notify` | Google Workspace, lead-data providers, proposal helpers, notifications |
| UI | `src/ui` | Shared React shell used by the agents' dashboards |

## Using it

Clone it **next to** the agent that uses it, so the folders sit side by side:

```
agents/
├── agent-core/
├── clara/
└── friday/
```

```bash
git clone https://github.com/OrionBuilds/orion-agent-core.git agent-core
cd agent-core
bash scripts/security/check-repo.sh
npm install
```

Clara's and FRIDAY's `package.json` point to it with `"@autom8ionlab/agent-core": "file:../agent-core"`.

## Settings it reads

The agent that uses agent-core passes these through its own `.env` file:

| Variable | Purpose |
|---|---|
| `ORION_SUPABASE_URL` | Your Orion Supabase project URL |
| `ORION_SUPABASE_ANON_KEY` | Your Orion anon (public) key, used for the agent's own sign-in |
| `ORION_OWNER_PROFILE` | Path to your owner profile JSON. Start from `src/config/owner-profile.example.json` |
| `ORION_PRINCIPALS` | Optional: the people besides the owner who may instruct the agent |
| `INTERAGENT_SHARED_SECRET` | A long random string shared by Clara, FRIDAY and Orion, used to sign requests between them |

## Develop

```bash
npm run typecheck
npm test
```

Before you build or run anything you've cloned or pulled, run `bash scripts/security/check-repo.sh`.

## Learn with the community

The free Autom8ion Lab classroom on Skool walks through setting up Orion, Clara, FRIDAY and Harvey. [[TODO: Skool community link]]

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
