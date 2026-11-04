import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend, selectBackend, smolvmSupport, type HostInfo } from '../src/backends.ts'
import { connect } from '../src/client.ts'
import { DockerBackend } from '../src/docker/index.ts'
import { missingSdk, SMOLMACHINES_VERSION, SmolvmBackend } from '../src/smolvm.ts'

const mac: HostInfo = { platform: 'darwin', arch: 'arm64', kvm: false }
const intelMac: HostInfo = { platform: 'darwin', arch: 'x64', kvm: false }
const kvmLinux: HostInfo = { platform: 'linux', arch: 'x64', kvm: true }
const plainLinux: HostInfo = { platform: 'linux', arch: 'arm64', kvm: false }
const windows: HostInfo = { platform: 'win32', arch: 'x64', kvm: false }

describe('selectBackend', () => {
  it('defaults to smolvm where the host runs it, and to docker elsewhere, saying why', () => {
    expect(selectBackend({ env: {}, host: mac })).toEqual({ name: 'smolvm', source: 'default', reason: 'This is macOS on Apple silicon, which runs smolvm.' })
    expect(selectBackend({ env: {}, host: kvmLinux })).toMatchObject({ name: 'smolvm', source: 'default', reason: expect.stringContaining('/dev/kvm') })
    for (const host of [intelMac, plainLinux, windows]) {
      expect(selectBackend({ env: {}, host })).toMatchObject({ name: 'docker', source: 'default', reason: expect.stringMatching(/smolvm needs .*Docker is the default here\.$/) })
    }
    expect(smolvmSupport(plainLinux)).toEqual({ supported: false, reason: 'smolvm needs /dev/kvm, which is missing here or which this user cannot open.' })
  })

  it('takes --backend over BLOBBY_SANDBOX_BACKEND over the default', () => {
    const env = { BLOBBY_SANDBOX_BACKEND: 'docker' }
    expect(selectBackend({ env, host: mac })).toEqual({ name: 'docker', source: 'environment', reason: 'BLOBBY_SANDBOX_BACKEND is set to docker.' })
    expect(selectBackend({ backend: 'smolvm', env, host: plainLinux })).toEqual({ name: 'smolvm', source: 'option', reason: 'It was asked for with --backend.' })
  })

  it('refuses names it does not know, with the ones it does', () => {
    expect(() => selectBackend({ backend: 'vmware', env: {} })).toThrow(expect.objectContaining({ code: 'unknown_backend', message: expect.stringContaining('smolvm, docker') }))
    expect(() => selectBackend({ env: { BLOBBY_SANDBOX_BACKEND: 'nope' } })).toThrow(expect.objectContaining({ code: 'unknown_backend', message: expect.stringContaining('BLOBBY_SANDBOX_BACKEND') }))
  })
})

describe('createBackend', () => {
  it('loads smolvm only when it is chosen', async () => {
    expect(await createBackend('smolvm', { env: {} })).toBeInstanceOf(SmolvmBackend)
  })

  it('loads docker only when it is chosen', async () => {
    expect(await createBackend('docker', { env: {} })).toBeInstanceOf(DockerBackend)
  })

  it('reports a backend that can\'t run here in doctor instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blobby-test-'))
    try {
      const env = { DOCKER_HOST: `unix://${join(dir, 'missing.sock')}`, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state') }
      const report = await connect({ backend: 'docker', env }).doctor()
      expect(report.backend).toMatchObject({ name: 'docker', source: 'option', reason: 'It was asked for with --backend.', ok: false, code: 'docker_unreachable', detail: expect.stringContaining('Docker isn\'t running'), capabilities: expect.objectContaining({ snapshot: true, branch: false }) })
      await expect(connect({ backend: 'docker', env }).list()).rejects.toMatchObject({ code: 'docker_unreachable' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves the backend to the server', () => {
    expect(() => connect({ server: 'http://127.0.0.1:1', backend: 'smolvm' })).toThrow(expect.objectContaining({ code: 'usage' }))
  })
})

describe('smolmachines, an optional peer dependency', () => {
  it('says how to install it when it is missing', () => {
    const error = missingSdk(Object.assign(new Error("Cannot find package 'smolmachines' imported from /somewhere/dist/smolvm.js"), { code: 'ERR_MODULE_NOT_FOUND' }))
    expect(error).toMatchObject({ code: 'smolvm_missing', message: expect.stringContaining(`npm install -g smolmachines@${SMOLMACHINES_VERSION}`) })
    expect(error!.message).not.toContain('/somewhere')
    expect(missingSdk(Object.assign(new Error("Cannot find package 'other'"), { code: 'ERR_MODULE_NOT_FOUND' }))).toBeNull()
    expect(missingSdk(new Error('smolmachines crashed'))).toBeNull()
  })

  it('reports the missing package in check, with its code', async () => {
    const backend = new SmolvmBackend({
      labels: {},
      load: async () => {
        throw missingSdk(Object.assign(new Error("Cannot find package 'smolmachines'"), { code: 'ERR_MODULE_NOT_FOUND' }))
      },
    })
    expect(await backend.check()).toMatchObject({ ok: false, code: 'smolvm_missing' })
    await expect(backend.list()).rejects.toMatchObject({ code: 'smolvm_missing' })
  })

  it('is an optional peer at the version the backend is tested with, and only the smolvm subpath loads it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies?.smolmachines).toBeUndefined()
    expect(manifest.peerDependencies.smolmachines).toBe(SMOLMACHINES_VERSION)
    expect(manifest.peerDependenciesMeta.smolmachines).toEqual({ optional: true })
    expect(manifest.devDependencies.smolmachines).toBe(SMOLMACHINES_VERSION)
    for (const file of ['backends', 'cli', 'client', 'index', 'router', 'sandboxes', 'serve', 'testing', 'fake', 'conformance']) {
      const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8')
      // Only dynamic imports, so smolvm and its SDK, and docker, load when chosen.
      expect(source, file).not.toMatch(/^import (?!type )[^\n]*from '(?:smolmachines|\.\/smolvm\.ts|\.\/docker\/[^']*)'/m)
      expect(source, file).not.toMatch(/^export [^\n]*from '\.\/(?:smolvm\.ts|docker\/[^']*)'/m)
    }
  })
})
