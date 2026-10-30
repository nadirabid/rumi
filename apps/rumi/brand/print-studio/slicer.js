/** Bambu Studio CLI slicing for one Print Studio job. */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { detectSlicer } from './probe.js'

const execFileAsync = promisify(execFile)
const ASSETS = join(import.meta.dirname, 'assets')
const TEMPLATE = join(ASSETS, 'h2d-project-settings.json')
const MACHINE = 'Bambu Lab H2D 0.4 nozzle.json'
const PROCESS = '0.20mm Standard @BBL H2D.json'
const FILAMENT = 'Bambu PLA Basic @BBL H2D.json'

/** Bambu's project setting labels for the printer's bed_type wire values. */
export const BED_TYPE_LABELS = {
  supertack_plate: 'Supertack Plate',
  textured_plate: 'Textured PEI Plate',
  cool_plate: 'Cool Plate',
  engineering_plate: 'Engineering Plate',
  hot_plate: 'High Temp Plate',
}

/** @param {string} home @returns {string} */
function defaultHome(home = process.env.DSH_HOME?.trim() || join(homedir(), '.rumi')) {
  return home
}

/** Run Bambu Studio and surface its last error line. */
async function runBambu(executable, args, timeout = 300_000) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    })
    return result
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim()
    const last = output.split('\n').filter(Boolean).slice(-3).join(' ')
    throw new Error(`Bambu Studio failed${last === '' ? '' : `: ${last}`}`)
  }
}

/** Resolve the installed H2D profiles. */
function profiles(slicer) {
  const root = join(slicer.path, 'Contents', 'Resources', 'profiles', 'BBL')
  const machine = join(root, 'machine', MACHINE)
  const process = join(root, 'process', PROCESS)
  const filament = join(root, 'filament', FILAMENT)
  for (const path of [machine, process, filament]) {
    if (!existsSync(path)) throw new Error(`Bambu Studio is missing the H2D profile ${path}`)
  }
  return { machine, process, filament }
}

/**
 * Slice one mesh into a printable H2D 3MF.
 * @param {string} meshPath - STL or 3MF source mesh.
 * @param {{ bedType?: string, home?: string, jobName?: string, filamentColor?: string, filamentType?: string }} [options]
 * @returns {Promise<{ file: string, name: string, bedType: string, seconds: number, layerHeight: number, jobDir: string }>}
 */
export async function sliceMesh(meshPath, options = {}) {
  if (!existsSync(meshPath)) throw new Error(`Mesh not found: ${meshPath}`)
  const slicer = detectSlicer()
  if (!slicer.found) throw new Error('Bambu Studio is not installed')
  if (!slicer.profiles.h2d) throw new Error('Bambu Studio has no H2D profiles')
  const bedType = options.bedType ?? 'supertack_plate'
  const filamentColor = options.filamentColor ?? '#FFFFFF'
  const filamentType = options.filamentType ?? 'PLA'
  const bedLabel = BED_TYPE_LABELS[bedType]
  if (bedLabel === undefined) throw new Error(`Unknown bed type: ${bedType}`)
  const jobDir = join(defaultHome(options.home), 'print-studio', 'jobs', randomUUID())
  mkdirSync(jobDir, { recursive: true })
  const source = join(jobDir, `source${extname(meshPath).toLowerCase()}`)
  writeFileSync(source, readFileSync(meshPath))
  const { machine, process, filament } = profiles(slicer)
  const project = join(jobDir, 'project.3mf')
  const outputName = `${(options.jobName ?? 'print-studio').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48)}.gcode.3mf`
  const output = join(jobDir, outputName)

  await runBambu(slicer.executable, [
    '--export-3mf', 'project.3mf',
    '--load-settings', `${machine};${process}`,
    '--load-filaments', filament,
    '--outputdir', jobDir,
    source,
  ])
  if (!existsSync(project)) throw new Error('Bambu Studio did not create the project 3MF')

  // A raw STL export is single-extruder; the valid H2D project needs the
  // dual-extruder physical map and eight filament slots from Studio.
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  template.curr_bed_type = bedLabel
  // H2D's AMS feeds the primary/right nozzle. Bambu Connect maps slice_info
  // filament_maps "1" to the secondary/left nozzle, so a left-only job shows
  // an unmapped "?" and cannot use the AMS. Target the primary nozzle.
  template.filament_map = template.filament_map.map(() => '2')
  const extracted = join(jobDir, 'project-files')
  mkdirSync(extracted, { recursive: true })
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', project, extracted], { timeout: 30_000 })
  writeFileSync(join(extracted, 'Metadata', 'project_settings.config'), JSON.stringify(template, null, 4))
  const modelSettings = join(extracted, 'Metadata', 'model_settings.config')
  if (existsSync(modelSettings)) {
    writeFileSync(modelSettings, readFileSync(modelSettings, 'utf8').replaceAll('key="extruder" value="1"', 'key="extruder" value="2"'))
  }
  rmSync(project)
  await execFileAsync('/usr/bin/zip', ['-q', '-r', '-X', project, '.'], { cwd: extracted, timeout: 30_000 })

  await runBambu(slicer.executable, [
    '--slice', '1',
    '--export-3mf', outputName,
    '--outputdir', jobDir,
    project,
  ])
  if (!existsSync(output)) throw new Error('Bambu Studio did not create the sliced 3MF')
  let result = {}
  try {
    result = JSON.parse(readFileSync(join(jobDir, 'result.json'), 'utf8'))
  } catch { /* result.json is optional for the caller */ }
  if (typeof result.error_string === 'string' && result.error_string !== 'Success.') {
    throw new Error(`Bambu Studio could not slice: ${result.error_string}`)
  }
  // Bambu Connect uses slice_info.filament_maps to group nozzles. Make the
  // used filament target the primary/right nozzle and carry the AMS colour so
  // its automatic tray match succeeds.
  const finalDir = join(jobDir, 'final-files')
  mkdirSync(finalDir, { recursive: true })
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', output, finalDir], { timeout: 30_000 })
  const sliceInfoPath = join(finalDir, 'Metadata', 'slice_info.config')
  if (existsSync(sliceInfoPath)) {
    let sliceInfo = readFileSync(sliceInfoPath, 'utf8')
    sliceInfo = sliceInfo.replace(/(<metadata key="filament_maps" value=")[^"]*(")/, `$1${Array(8).fill('2').join(' ')}$2`)
    sliceInfo = sliceInfo.replace(/color="#[0-9A-Fa-f]{6,8}"/g, `color="${filamentColor}"`)
    writeFileSync(sliceInfoPath, sliceInfo)
  }
  const platePath = join(finalDir, 'Metadata', 'plate_1.json')
  if (existsSync(platePath)) {
    const plate = JSON.parse(readFileSync(platePath, 'utf8'))
    plate.filament_colors = [filamentColor]
    writeFileSync(platePath, JSON.stringify(plate))
  }
  const projectPath = join(finalDir, 'Metadata', 'project_settings.config')
  if (existsSync(projectPath)) {
    const project = JSON.parse(readFileSync(projectPath, 'utf8'))
    if (Array.isArray(project.filament_colour)) project.filament_colour = project.filament_colour.map(() => filamentColor)
    if (Array.isArray(project.filament_type)) project.filament_type = project.filament_type.map(() => filamentType)
    writeFileSync(projectPath, JSON.stringify(project, null, 4))
  }
  rmSync(output)
  await execFileAsync('/usr/bin/zip', ['-q', '-r', '-X', output, '.'], { cwd: finalDir, timeout: 30_000 })
  const plate = result.sliced_plates?.[0] ?? {}
  return {
    file: output,
    filamentColor,
    filamentType,
    name: outputName,
    bedType,
    seconds: Number(plate.total_predication ?? 0),
    layerHeight: Number(result.layer_height ?? 0),
    jobDir,
  }
}
