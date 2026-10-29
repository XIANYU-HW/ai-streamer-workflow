<div align="center">

<img src="assets/hero.svg" alt="Nichang — AI Streamer Workflow." width="100%">

# Nichang · 霓裳

**AI Streamer Workflow**

**Set up your AI broadcast crew. Bring multiple AI hosts onto one stage.**

An open-source workflow kit working toward autonomous livestreams, from setup to wrap-up.

[![Verify source](https://github.com/XIANYU-HW/ai-streamer-workflow/actions/workflows/verify.yml/badge.svg)](https://github.com/XIANYU-HW/ai-streamer-workflow/actions/workflows/verify.yml)
[![MIT](https://img.shields.io/badge/license-MIT-79DFC1?style=flat-square)](../LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522.12-ABC4FF?style=flat-square)](https://nodejs.org/en/download)
[![Preview](https://img.shields.io/badge/v0.1.0-developer_preview-FFB593?style=flat-square)](roadmap.md)

[简体中文](../README.md) · **English**

[Quick start](#quick-start) · [Studio preview](#studio-preview) · [Integration guide](../packages/runtime/INTEGRATION.md) · [Contribute](contributing.md)

</div>

> **v0.1.0 · First public preview · Under active development**  
> Nichang is an early version with known rough edges. Work will continue on fixes, integrations, and usability. Reproducible reports are welcome; see [known limitations](known-limitations.md) and the [roadmap](roadmap.md).  
> Includes a studio, seven role templates, a two-host orchestration core, and an offline demo. Setup prepares the applications and role prompts. Actual agent sessions, models, voices, game controls, and streaming platforms still require integration. **A full broadcast without step-by-step human guidance is the project goal, not an end-to-end capability verified by this release.**

## A crew for the whole show

Running a livestream involves more than generating speech. Gameplay, hosting, audience responses, stage production, and shutdown need to work together. This kit separates those responsibilities into seven roles, while leaving the AI, characters, game, and platform up to you.

| Assemble a team | Coordinate two hosts | Build a complete workflow |
| :--- | :--- | :--- |
| Seven role prompts and an Agent Skill; no prescribed model provider | Host A/B configuration, player rotation, and one shared speech queue | Integration checks, bounded rehearsals, operation, recovery, and shutdown evidence |

## Studio preview

![Actual studio screenshot from a fresh workspace; no broadcast running](assets/studio-preview.png)

*Captured from the current source with a fresh local data directory. No characters, voices, or broadcast history are bundled. This is a product interface preview, not a live broadcast recording.*

![Seven-role workflow and required external integrations](assets/team-flow.svg)

*Workflow illustration. External models, games, voices, and platforms require their own adapters and verification. The studio and generic runtime also need an integration host to connect them.*

## Quick start

Install [Node.js 22.12 or newer](https://nodejs.org/en/download), including npm. An internet connection is needed to download application dependencies.

```sh
git clone https://github.com/XIANYU-HW/ai-streamer-workflow.git
cd ai-streamer-workflow
npm run setup
npm run doctor
npm run studio
```

On Windows, you can also double-click `Setup-Windows.cmd`. On macOS/Linux, run `sh setup.sh`. Setup installs Electron dependencies and creates `.local/workflow.json` and the role plan. It does not start games, speech, recording, or broadcasting. Re-running it preserves existing configuration and modified skills.

A fresh `doctor` report will show adapters as `UNCONFIGURED / NOT_VERIFIED` until you connect them.

For a finite offline demo without downloading the desktop runtime:

```sh
npm run setup -- --skip-install
npm run demo
```

The demo exercises gift priority, deduplication, player rotation, component recovery, and stop confirmations using simulated adapters. Its output explicitly includes `simulated: true`; it does not play real games, generate speech, or start a broadcast. A full setup is still needed to launch the studio.

## Connect your crew

1. Configure your hosts, models, voices, game, and output platform in `.local/workflow.json`. Providers, model names, and reasoning settings start unset. Keep credentials in the application's local secure settings.
2. Ask a compatible AI client to read [SKILL.md](../skills/ai-streamer-workflow/SKILL.md). Setup creates prompts and a plan, not active agents. Clients with session-creation tools can create the roles and record receipts; otherwise use the seven prompts in `.local/agent-plan/` manually.
3. Implement the actual model, game, speech, audience-event, and broadcast adapters using the [integration contract](../packages/runtime/INTEGRATION.md).
4. Verify gameplay responses, audio in the programme output, capture, and shutdown before an authorized recording or broadcast. Follow the [operation guide](../skills/ai-streamer-workflow/references/operation.md).

Example request to your AI client:

```text
Read this project's Skill and prepare the seven role sessions using my chosen AI
and models. Check the integrations and list missing adapters. Do not start a broadcast yet.
```

| Role | Responsibility |
| :--- | :--- |
| Coordinator | Goals, configuration, and cross-role decisions |
| Broadcast director | Programme pacing, output, and standby transitions |
| Gameplay performer | Exclusive game control and coordinated hosting |
| Audience manager | Select comments and verify gift events |
| Game adaptation engineer | Connect game observations, inputs, and feedback |
| Studio and audio engineer | Characters, scenes, voices, and output routing |
| Independent reviewer | Verify evidence at each stage |

## What is included

| Component | Available now | Still required |
| :--- | :--- | :--- |
| Studio | Blank character library, scene/character editing, voice settings, stage source | Your assets, voices, animations, and capture setup |
| Runtime | Exclusive control lease, one speech queue, gift priority/deduplication, rotation, health, stop state | Persistent integration host and real drivers |
| Games | Adapter contract and a dedicated role | Per-game observation, input, and real-device tests |
| Audience | Standard event contract and simulated events | Permitted platform event sources and real gift verification |
| AI/models | Role templates and capability requirements | Selected client/API and actual decision integration |
| Programme output | Studio and optional output window | Audio/video routing, platform software, and broadcast verification |

The default player rotation is 15 minutes. Both hosts can speak; ordinary comments are selected rather than answered exhaustively, while trusted gifts receive priority. Local failures can be recovered without resetting the programme clock. Major repairs use standby output. User stop requests take precedence.

See [verification status](verification-status.md) and [platform support](platform-support.md) for the tested scope. Offline logic tests do not establish real platform streaming. This repository ships source, not signed desktop installers. Most detailed implementation guides currently use Chinese.

## Develop and contribute

Real adapters, platform testing, and reproducible bug reports are especially useful. Read the [roadmap](roadmap.md) and [contribution guide](contributing.md).

```sh
npm test
npm run check:release
npm run release
```

The release command produces a clean source ZIP, SHA256 checksum, and file manifest. Local data, credentials, recordings, and dependencies are excluded.

[Architecture](architecture.md) · [Verification](../skills/ai-streamer-workflow/references/verification.md) · [Packaging](release.md) · [Report an issue](https://github.com/XIANYU-HW/ai-streamer-workflow/issues/new/choose)

## License

Original project code and documentation are released under the [MIT License](../LICENSE). Third-party dependencies retain their own licenses; see [third-party notices](../THIRD_PARTY_NOTICES.md). Models, character assets, voices, and platform services have separate terms.

<div align="center">

Created by [清风作梦 · Dreaming Breeze](https://github.com/XIANYU-HW)

</div>
