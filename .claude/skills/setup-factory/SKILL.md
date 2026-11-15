---
name: setup-factory
description: Guided setup of which model each factory agent runs on; shows the default setup, detects available models, writes factory/config.json.
disable-model-invocation: true
---

# Setup factory

Walk the user through choosing a model for every **slot**: one place
`factory/config.json` names the model an agent runs on. The slots are the four
pipeline roles (`intake`, `spec-writer`, `builder`, `approver`), the code
reviewer per risk (`routing.<risk>.code`) and the surface reviewers
(`surface_reviewers.<surface>.<reviewer>`).

Every read and write goes through `factory/bin/models`. It checks each choice
against the detected **catalog** and writes the config in its house style, so a
setup is only ever as valid as what this session can actually spawn. Its usage
and rules are in its docstring (`head -25 factory/bin/models`).

## 1. Detect the catalog

Load `orchestrator_capabilities` with ToolSearch and call it with no arguments.
Write its result, verbatim, to `capabilities.json` in your scratchpad
(outside the repo). Then run:

```
factory/bin/models catalog --available <scratchpad>/capabilities.json
```

Done when the catalog lists at least one model. When the user later asks for a
model the catalog lacks (it notes how many models each provider left out),
call `orchestrator_capabilities` with `search` set to that model's name, save
the result as a second file and pass `--available` once per file from then on.
Without `orchestrator_capabilities` the factory cannot spawn agents at all:
tell the user `/setup-factory` needs T3 Code and stop.

## 2. Show the default setup beside the current one

```
factory/bin/models show --default --available <files>
factory/bin/models show --available <files>
```

Show the user both tables, the default first. Say in one line each what the
slot groups do, and name every slot marked `NOT AVAILABLE`: that model cannot
be spawned here, so the slot must change before the setup can run.

## 3. Pick a starting point

Ask with AskUserQuestion (plain numbered questions if it is unavailable):

- **Default setup**: offer it only when it has no `NOT AVAILABLE` slot.
- **Keep current**: offer it only when it differs from the default and has no
  `NOT AVAILABLE` slot.
- **Customize**: start from the current setup and change chosen slots.

Done when the user has picked one. Default goes straight to step 5 as
`models reset`; Keep current ends the skill with nothing written.

## 4. Customize

First ask which groups to change (multiSelect): pipeline roles, code reviewers,
surface reviewers. Every `NOT AVAILABLE` slot is in scope whatever they pick.

Then ask one question per slot in scope, up to four questions per
AskUserQuestion call. Each option is a catalog model with its effort, labelled
like `opus-5-5 · high`; give three options, put your recommendation first, and
let the user type any other catalog model as `Other`. Recommend by the slot's
work:

- `builder` writes the code: the strongest coding model.
- `intake`, `spec-writer`, `approver` are judgment and prose: a strong
  reasoning model.
- A reviewer reads best from a different model family than the builder, so
  its read stays independent of the builder's habits. Reviewers never run on
  Haiku; `models set` refuses it.

Done when every slot in scope has an answer.

## 5. Write it

Apply every answer in one call, each as `<slot>=<provider>/<model>[:<option>=<value>,...]`
with the provider and model exactly as the catalog prints them:

```
factory/bin/models set builder=codex/gpt-6.1-sol:reasoningEffort=high routing.high.code=claudeAgent/claude-opus-5-5:effort=high --available <files>
```

`set` writes nothing unless every assignment passes. When it refuses, its
message names the slot and the reason: re-ask that slot alone and run `set`
again with every answer. Done when `set` (or `reset`) exits 0.

## 6. Report

Show the table `set` printed and `git diff --stat factory/config.json`. Tell the
user:

- The next agent the factory spawns uses the new setup; a job already routed
  keeps its reviewers until it finishes.
- `factory/config.json` is a protected path, so no factory job will change it;
  committing the new setup is theirs to do.
- Re-running `/setup-factory` changes it again, and choosing **Default setup**
  restores the shipped one.
