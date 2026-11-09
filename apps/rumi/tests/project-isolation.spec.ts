import { projectInstructionsFor } from '../brand/projects/index.js'
/** Project data confinement rejects sibling paths and inherited subprocess escapes. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonical, checkedPath, contains, projectRoot, seatbeltProfile } from '../brand/projects/isolation/paths.js'
const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'rumi-isolation-')); directories.push(workspace)
  const id = '11111111-1111-4111-8111-111111111111'
  const root = join(workspace, id), other = join(workspace, 'other')
  await mkdir(root); await mkdir(other)
  await writeFile(join(root, 'project.json'), JSON.stringify({ id, sessionIds: ['session-a'] }))
  await writeFile(join(root, 'own.txt'), 'own'); await writeFile(join(other, 'secret.txt'), 'other project')
  await symlink(other, join(root, 'escape'))
  return { workspace, root: canonical(root), other: canonical(other), session: { id: 'session-a', header: { cwd: root } } }
}
it('binds sessions to registered projects and rejects a forged or unregistered working directory', async () => {
  const f = await fixture()
  expect(projectRoot(f.workspace, f.session)).toBe(f.root)
  expect(() => projectRoot(f.workspace, { ...f.session, id: 'another-session' })).toThrow('registered')
  expect(() => projectRoot(f.workspace, { ...f.session, header: { cwd: f.other } })).toThrow('project')
})
it('denies absolute, traversal, sibling-prefix and symlink escapes for reads and writes', async () => {
  const f = await fixture()
  for (const write of [false, true]) for (const path of [join(f.other, 'secret.txt'), '../other/secret.txt', 'escape/secret.txt', 'escape/new/file.txt']) {
    expect(() => checkedPath(f.root, path, write, [])).toThrow('isolation denied')
  }
  expect(contains(f.root, f.root+'-sibling/file')).toBe(false)
  expect(checkedPath(f.root, 'new/file.txt', true, [])).toBe(join(f.root, 'new/file.txt'))
  expect(() => checkedPath(f.root, 'project.json', true, [])).toThrow('isolation denied')
})
it('allows shared runtime reads but never runtime writes', async () => {
  const f = await fixture()
  expect(checkedPath(f.root, join(f.other, 'secret.txt'), false, [f.other])).toBe(join(f.other, 'secret.txt'))
  expect(() => checkedPath(f.root, join(f.other, 'secret.txt'), true, [f.other])).toThrow('isolation denied')
})
it.skipIf(process.platform !== 'darwin')('enforces reads and writes in the kernel for shell children, including symlinks and scratch files', async () => {
  const f = await fixture()
  const script = 'cat "$1/own.txt"; printf changed > "$1/own.txt"; cat "$2/secret.txt"; cat "$1/escape/secret.txt"; printf stolen > "$2/new.txt"; printf replaced > "$1/project.json"; exit 0'
  const result = await execute('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(f.root, ['/bin', '/usr', '/System']), '/bin/sh', '-c', script, 'test', f.root, f.other], { timeout: 30000 })
  expect(result.stdout).toBe('own')
  expect(result.stderr).toContain('Operation not permitted')
  expect(await readFile(join(f.root, 'own.txt'), 'utf8')).toBe('changed')
  expect(await readFile(join(f.other, 'secret.txt'), 'utf8')).toBe('other project')
  await expect(readFile(join(f.other, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(projectRoot(f.workspace, f.session)).toBe(f.root)
})

it.skipIf(process.platform !== 'darwin')('keeps node children confined when they request an unrestricted nested sandbox', async () => {
  const f = await fixture()
  const source = `const fs=require('fs'), cp=require('child_process');
    try { fs.readFileSync(process.argv[1]); process.exit(2) } catch(e) { if(e.code!=='EPERM' && e.code!=='EACCES') throw e }
    const child=cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1) (allow default)','/bin/cat',process.argv[1]],{encoding:'utf8'});
    if(child.status===0 || child.stdout.includes('other project'))process.exit(3);console.log('confined');`
  const result = await execute('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(f.root, ['/bin', '/usr', '/System', '/opt/homebrew']), process.execPath, '-e', source, join(f.other, 'secret.txt')], { cwd: f.root, timeout: 30000 })
  expect(result.stdout.trim()).toBe('confined')
})

it.skipIf(process.platform !== 'darwin')('prevents link creation and directory swapping that could race host path checks', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'original')); await mkdir(join(f.root, 'replacement'))
  const source = `const fs=require('fs');const root=process.argv[1];let denied=0;
    for(const action of [()=>fs.symlinkSync(root+'/own.txt',root+'/new-link'),()=>fs.linkSync(root+'/own.txt',root+'/hard-link'),()=>fs.renameSync(root+'/replacement',root+'/original')]) {
      try {action()}catch(e){if(e.code==='EPERM'||e.code==='EACCES')denied++;else throw e}
    } console.log(denied);`
  const result = await execute('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(f.root, ['/bin', '/usr', '/System', '/opt/homebrew']), process.execPath, '-e', source, f.root], { cwd: f.root, timeout: 30000 })
  expect(result.stdout.trim()).toBe('3')
})

it('does not load live voice instructions through a link outside the project', async () => {
  const f = await fixture()
  await symlink(join(f.other, 'secret.txt'), join(f.root, 'AGENTS.md'))
  const store = { list: async () => [{ path: f.root, sessionIds: ['session-a'] }] }
  await expect(projectInstructionsFor(store, 'session-a')).rejects.toThrow('isolation denied')
})
