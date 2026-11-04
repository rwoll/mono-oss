import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { SandboxError } from './backend.ts'

/**
 * A recipe is a folder: `recipe.json`, plus scripts that run only inside the sandbox.
 *
 *   setup.sh   runs once, as root, after the runtime's own setup; a base is installed per recipe
 *   boot.sh    runs as root at every boot, before the session starts
 *   <step>     each step in recipe.json, run as the desktop user after a new sandbox starts
 *
 * Nothing in a recipe runs on the client or the server, so recipes are safe to share.
 */

export const RECIPE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** Callbacks are named `<secret>.<field>`, such as `github.password`. */
export const CALLBACK_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9-]*$/
const FILE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_FILES = 200
const MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_RECIPE = 'vscode-insiders'

export const RecipeSpecSchema = z.strictObject({
  apiVersion: z.literal(1),
  description: z.string().max(300).optional(),
  callbacks: z.record(z.string().regex(CALLBACK_NAME), z.strictObject({ sensitive: z.boolean().optional() })).default({}),
  steps: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        run: z.string().regex(FILE_PATH),
        uses: z.array(z.string().regex(CALLBACK_NAME)).max(50).default([]),
        timeoutSeconds: z.number().int().min(10).max(3600).optional(),
      }),
    )
    .max(20)
    .default([]),
})
export type RecipeSpec = z.output<typeof RecipeSpecSchema>
export type RecipeStep = RecipeSpec['steps'][number]

export interface Recipe {
  id: string
  spec: RecipeSpec
  /** The recipe's files by relative path, recipe.json included. */
  files: Map<string, Uint8Array>
  builtin: boolean
}

/** A recipe as it travels from a client to a server: built in, by name, or uploaded. */
export const RecipeRefSchema = z.union([
  z.strictObject({ builtin: z.string().regex(RECIPE_ID) }),
  z.strictObject({ id: z.string().regex(RECIPE_ID), files: z.record(z.string().regex(FILE_PATH), z.string()) }),
])
export type RecipeRef = z.output<typeof RecipeRefSchema>

export const builtinRecipesDir = fileURLToPath(new URL('../recipes/', import.meta.url))

/** Checks a recipe's files and its recipe.json. Messages say what to fix. */
export function parseRecipe(id: string, files: Map<string, Uint8Array>, builtin: boolean): Recipe {
  if (!RECIPE_ID.test(id)) throw new SandboxError('invalid_recipe', `"${id}" is not a valid recipe name. Use lowercase letters, digits, and dashes.`)
  if (files.size > MAX_FILES) throw new SandboxError('invalid_recipe', `Recipe ${id} has more than ${MAX_FILES} files.`)
  const bytes = [...files.values()].reduce((sum, file) => sum + file.byteLength, 0)
  if (bytes > MAX_BYTES) throw new SandboxError('invalid_recipe', `Recipe ${id} is larger than ${MAX_BYTES / 1024 / 1024} MB.`)
  for (const path of files.keys()) {
    if (!FILE_PATH.test(path) || path.split('/').includes('..')) throw new SandboxError('invalid_recipe', `Recipe ${id} has a file with an invalid path: ${path}`)
  }
  const manifest = files.get('recipe.json')
  if (!manifest) throw new SandboxError('invalid_recipe', `Recipe ${id} has no recipe.json.`)
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(manifest).toString('utf8'))
  } catch {
    throw new SandboxError('invalid_recipe', `Recipe ${id}'s recipe.json is not valid JSON.`)
  }
  const parsed = RecipeSpecSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new SandboxError('invalid_recipe', `Recipe ${id}'s recipe.json: ${issue.path.join('.') || 'root'}: ${issue.message}`)
  }
  for (const step of parsed.data.steps) {
    if (!files.has(step.run)) throw new SandboxError('invalid_recipe', `Recipe ${id}'s step "${step.name}" runs ${step.run}, which is not in the recipe.`)
    for (const name of step.uses) {
      if (!(name in parsed.data.callbacks)) throw new SandboxError('invalid_recipe', `Recipe ${id}'s step "${step.name}" uses ${name}, which is not in its callbacks.`)
    }
  }
  return { id, spec: parsed.data, files, builtin }
}

async function readFolder(dir: string): Promise<Map<string, Uint8Array>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => {
    throw new SandboxError('invalid_recipe', `There is no recipe folder at ${dir}.`)
  })
  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const rel = relative(dir, path).split(sep).join('/')
    if (rel.split('/').some((part) => part.startsWith('.'))) continue
    files.set(rel, await readFile(path))
  }
  return files
}

export async function builtinRecipeIds(): Promise<string[]> {
  const entries = await readdir(builtinRecipesDir, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && RECIPE_ID.test(entry.name)).map((entry) => entry.name).sort()
}

export async function loadBuiltinRecipe(id: string): Promise<Recipe> {
  if (!RECIPE_ID.test(id) || !(await builtinRecipeIds()).includes(id)) {
    throw new SandboxError('unknown_recipe', `There is no built-in recipe named ${id}. Built-in recipes: ${(await builtinRecipeIds()).join(', ')}.`)
  }
  return parseRecipe(id, await readFolder(join(builtinRecipesDir, id)), true)
}

/** The built-in recipes, with the callbacks their steps ask for. */
export async function describeBuiltinRecipes(): Promise<{ id: string; description: string; callbacks: RecipeSpec['callbacks']; steps: string[] }[]> {
  const recipes = await Promise.all((await builtinRecipeIds()).map((id) => loadBuiltinRecipe(id)))
  return recipes.map((recipe) => ({ id: recipe.id, description: recipe.spec.description ?? '', callbacks: recipe.spec.callbacks, steps: recipe.spec.steps.map((step) => step.name) }))
}

/** Resolves a recipe a client sent: a built-in one, or the files of an uploaded one. */
export async function resolveRecipe(ref: RecipeRef): Promise<Recipe> {
  if ('builtin' in ref) return loadBuiltinRecipe(ref.builtin)
  // A built-in recipe's name would make sandboxes of this one get the built-in's files and steps later.
  if ((await builtinRecipeIds()).includes(ref.id)) {
    throw new SandboxError('invalid_recipe', `${ref.id} is the name of a built-in recipe. Rename the folder of yours, for example to my-${ref.id}.`)
  }
  return parseRecipe(ref.id, new Map(Object.entries(ref.files).map(([path, data]) => [path, Buffer.from(data, 'base64')])), false)
}

/**
 * What a client sends for `--recipe`: a built-in recipe by name, or a folder on the client, uploaded,
 * so the server never needs to see the client's disk.
 */
export async function recipeRef(value: string, cwd = process.cwd()): Promise<RecipeRef> {
  if (RECIPE_ID.test(value) && !value.includes('/')) return { builtin: value }
  const dir = resolve(cwd, value)
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new SandboxError('invalid_recipe', `${value} is neither a built-in recipe nor a folder.`)
  const id = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'custom'
  const files = await readFolder(dir)
  parseRecipe(id, files, false)
  return { id, files: Object.fromEntries([...files].map(([path, data]) => [path, Buffer.from(data).toString('base64')])) }
}
