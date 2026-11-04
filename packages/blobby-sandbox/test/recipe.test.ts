import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinRecipeIds, loadBuiltinRecipe, parseRecipe, recipeRef, resolveRecipe } from '../src/recipe.ts'

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]))
const manifest = (value: object) => JSON.stringify({ apiVersion: 1, ...value })

describe('built-in recipes', () => {
  it('are valid, and sign nothing in: that is `exec --secret` with a script', async () => {
    expect(await builtinRecipeIds()).toEqual(['desktop', 'vscode-insiders'])
    const recipe = await loadBuiltinRecipe('vscode-insiders')
    expect(recipe.spec.callbacks).toEqual({})
    expect(recipe.spec.steps).toEqual([])
    expect([...recipe.files.keys()].sort()).toEqual(['boot.sh', 'recipe.json', 'setup.sh'])
    await expect(loadBuiltinRecipe('nope')).rejects.toMatchObject({ code: 'unknown_recipe' })
  })
})

describe('parseRecipe', () => {
  it.each([
    [{}, /no recipe\.json/],
    [{ 'recipe.json': '{' }, /not valid JSON/],
    [{ 'recipe.json': JSON.stringify({ apiVersion: 2 }) }, /apiVersion/],
    [{ 'recipe.json': manifest({ steps: [{ name: 'Go', run: 'go.mjs' }] }) }, /runs go\.mjs, which is not in the recipe/],
    [{ 'recipe.json': manifest({ steps: [{ name: 'Go', run: 'go.mjs', uses: ['a.b'] }] }), 'go.mjs': '' }, /uses a\.b, which is not in its callbacks/],
    [{ 'recipe.json': manifest({}), '../escape.sh': '' }, /invalid path/],
  ])('explains what is wrong: %#', (entries, message) => {
    expect(() => parseRecipe('custom', files(entries), false)).toThrow(message)
  })
})

describe('recipeRef', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blobby-recipe-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('sends built-in recipes by name, and uploads a folder on the client, without hidden files', async () => {
    expect(await recipeRef('desktop')).toEqual({ builtin: 'desktop' })
    const folder = join(dir, 'My Recipe')
    await mkdir(join(folder, 'steps'), { recursive: true })
    await mkdir(join(folder, '.git'))
    await writeFile(join(folder, 'recipe.json'), manifest({ callbacks: { 'npm.token': { sensitive: true } }, steps: [{ name: 'Log in', run: 'steps/login.mjs', uses: ['npm.token'] }] }))
    await writeFile(join(folder, 'steps', 'login.mjs'), 'export {}')
    await writeFile(join(folder, '.git', 'HEAD'), 'ref')
    const ref = await recipeRef('./My Recipe', dir)
    expect(ref).toMatchObject({ id: 'my-recipe' })
    expect(Object.keys((ref as { files: object }).files).sort()).toEqual(['recipe.json', 'steps/login.mjs'])
    const recipe = await resolveRecipe(ref)
    expect(recipe).toMatchObject({ id: 'my-recipe', builtin: false })
    expect(Buffer.from(recipe.files.get('steps/login.mjs')!).toString()).toBe('export {}')
    await expect(recipeRef('./missing', dir)).rejects.toMatchObject({ code: 'invalid_recipe' })
    const copy = join(dir, 'vscode-insiders')
    await mkdir(copy)
    await writeFile(join(copy, 'recipe.json'), manifest({}))
    await expect(resolveRecipe(await recipeRef('./vscode-insiders', dir))).rejects.toThrow(/name of a built-in recipe\. Rename the folder/)
  })
})
