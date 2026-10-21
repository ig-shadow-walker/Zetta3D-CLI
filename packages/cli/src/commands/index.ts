import type { AnyCommand } from '../core/define'
import type { GroupInfo } from '../core/program'
import { accountCommands, billingCommands } from './account'
import { assetCommands } from './asset'
import { authCommands } from './auth'
import { catalogCommands } from './catalog'
import { configCommands } from './config'
import { generateCommands } from './generate'
import { pipelineCommands } from './pipeline'
import { refineCommands } from './refine'
import { runCommands } from './run'
import { splatCommands } from './splat'
import { upgradeCommand } from './upgrade'
import { imageCommands } from './image'
import { integrationCommands } from './integrations'
import { mcpCommand } from './mcp'
import { metaCommands, registry } from './meta'

export const GROUPS: GroupInfo[] = [
  { name: 'auth', summary: 'Sign in and out; see who you are signed in as.' },
  { name: 'account', summary: 'Your account, credits, usage history and onboarding.' },
  { name: 'billing', summary: 'Plans, subscription, checkout and billing portal links.' },
  { name: 'catalog', summary: 'Engines, prices and what your plan allows.' },
  { name: 'splat', summary: 'Gaussian-splat worlds from pictures or video (early access).' },
  { name: 'refine', summary: 'Finishing tools: retopology, segmentation, UVs, texturing, rigging, conversion.' },
  { name: 'asset', summary: 'Your 3D library: list, inspect, wait, download, share, delete, import.' },
  { name: 'image', summary: 'Image Studio: generate, edit, compose pictures; remove backgrounds.' },
  { name: 'pipeline', summary: 'Saved multi-step recipes: create, validate, estimate, run, batch.' },
  { name: 'run', summary: 'Pipeline runs: watch, start, pause, retry steps, collect outputs.' },
  { name: 'config', summary: 'Settings and profiles.' },
  { name: 'skill', summary: 'Install the agent skill that teaches AI tools to use this CLI.' },
]

export const COMMANDS: AnyCommand[] = [
  ...authCommands,
  ...generateCommands,
  ...splatCommands,
  ...refineCommands,
  ...accountCommands,
  ...billingCommands,
  ...catalogCommands,
  ...assetCommands,
  ...imageCommands,
  ...pipelineCommands,
  ...runCommands,
  ...configCommands,
  ...metaCommands,
  mcpCommand,
  ...integrationCommands,
  upgradeCommand,
]

registry.commands = COMMANDS

export const INTRO = `Get started:
  zetta auth login                         sign in (or set ZETTA_TOKEN)
  zetta generate --image chair.png --out . make a 3D model from a picture
  zetta asset list                         your library
  zetta guide                              how agents should use this CLI
  zetta commands --json                    every command and flag, machine-readable`
