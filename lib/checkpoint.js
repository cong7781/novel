/**
 * On-disk run artifacts, so a long extraction can be inspected, replayed, and resumed.
 *
 * Layout:
 *   <runDir>/manifest.json     what was run, against which text hash, with which model
 *   <runDir>/chunks.json       the exact window boundaries used
 *   <runDir>/cast.json         RAG stage-1 output (cast + aliases)
 *   <runDir>/plan.json         which blocks were selected for extraction and why the others were not
 *   <runDir>/blocks/XXXX.json  one verified extraction per chunk (the resumable unit)
 *   <runDir>/failures.json     chunks that failed after retries (resume retries these)
 *   <runDir>/result.json       the merged graph, ready for the viewer
 *
 * Writes are atomic (temp file + rename): killing a run mid-write must not leave a half JSON that
 * blocks the resume path.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function textHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

export function createRunStore(runDir) {
  const blocksDir = join(runDir, 'blocks')

  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await rename(temporary, path)
    return path
  }

  return {
    dir: runDir,
    blocksDir,

    async ensure() {
      await mkdir(blocksDir, { recursive: true })
    },

    readManifest: () => readJson(join(runDir, 'manifest.json')),
    writeManifest: (value) => writeJson(join(runDir, 'manifest.json'), value),

    readChunks: () => readJson(join(runDir, 'chunks.json')),
    writeChunks: (value) => writeJson(join(runDir, 'chunks.json'), value),

    readCast: () => readJson(join(runDir, 'cast.json')),
    writeCast: (value) => writeJson(join(runDir, 'cast.json'), value),

    readPlan: () => readJson(join(runDir, 'plan.json')),
    writePlan: (value) => writeJson(join(runDir, 'plan.json'), value),

    readFailures: () => readJson(join(runDir, 'failures.json')),
    writeFailures: (value) => writeJson(join(runDir, 'failures.json'), value),

    readBlock(index) {
      return readJson(join(blocksDir, `${String(index).padStart(4, '0')}.json`))
    },
    writeBlock(index, value) {
      return writeJson(join(blocksDir, `${String(index).padStart(4, '0')}.json`), value)
    },

    async listBlocks() {
      try {
        const names = await readdir(blocksDir)
        return new Set(
          names
            .filter((name) => name.endsWith('.json'))
            .map((name) => Number.parseInt(name, 10))
            .filter((value) => Number.isInteger(value)),
        )
      } catch {
        return new Set()
      }
    },

    readResult: () => readJson(join(runDir, 'result.json')),
    writeResult: (value) => writeJson(join(runDir, 'result.json'), value),

    /** Any extra artifact next to result.json (merge report, warnings, …). */
    writeNamed: (name, value) => writeJson(join(runDir, name), value),
    readNamed: (name) => readJson(join(runDir, name)),
  }
}
