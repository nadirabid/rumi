---
kind: upgrade-guide
description: Rumi checks saved named regions against each model and removes invalid maps.
---

# Named regions in saved projects

English | [中文](README.zh.md)

## Change

Rumi checks print projects at startup and when opened. Each named feature needs a supported location, and each surface selection must resolve on the saved USD revision. A single invalid feature invalidates the model's region map.

## Migration

Open the project and continue the conversation. Rumi gives the agent the paths of models that need named regions. The agent follows the naming skill to recreate and check each map. Hover over a physical feature in Named regions mode to inspect its selection.
